"""What-if and sensitivity analysis (DESIGN.md section 2): levers on a day's request, each variant solved
with the same budget and seeds as the baseline, and compared with it.

What a lever may change (owner rules):
- Flex / WidenPreference move only windows labelled SALES_PREFERENCE. UNKNOWN windows move only in a variant
  labelled HYPOTHETICAL. CUSTOMER_HARD windows never move.
- Afternoon / Night extend the windows of customers who accept afternoon / night deliveries (same provenance
  rule). When the new end is after the normal day's end (normal_end_min: the latest return or depot closing),
  the truck day is extended too: a second driver shift, priced as an explicit assumption, and every other
  customer is still served inside the normal shift's hours.
- FasterUnloading / FasterReload need evidence first (requires_evidence). They are reported apart, as
  operational improvement potential, never as a baseline.
Breaks, the normal shift's limits, capacity, pallet fill, allowed trucks, trips and order sizes never change:
``guard`` checks every variant before anything is solved.

Money: cash is the engine's operating cost, plus the second-driver assumption for a truck that works past the
normal shift. Solver penalties are ARTIFICIAL and reported apart. Minutes and trips are a third column.
"""
from __future__ import annotations

import itertools
import math
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field, fields, replace
from pathlib import Path
from typing import ClassVar

from dispatch_models import DAY_MIN, DispatchRequest, DispatchScenario, DispatchStop, DispatchTruck

from . import core, ivms, synth
from .core import Budget, RunResult
from .history import RealDay
from .synth import SALES_PREFERENCE, UNKNOWN, SynthDay

DEFAULT_AFTERNOON_UNTIL = 18 * 60
DEFAULT_NIGHT_UNTIL = 23 * 60
# The web's default "Daily driver day rate" (apps/web/lib/dispatch/hire.ts DEFAULT_DRIVER_DAY_RATE): the price
# of a second driver's shift when the request carries no day rate of its own.
DEFAULT_SECOND_DRIVER_OMR = 10.0
SPEED_REGION = "Muscat"  # the depot's region in the IVMS report (its 'vechicle_type' column holds regions)
DAY_BANDS = ("06-09", "09-12", "12-15", "15-18")  # the hours the engine's one speed stands for
EVENING_BAND, NIGHT_BAND = "18-22", "22-06"


def _hhmm(minute: int) -> str:
    return f"{minute // 60:02d}:{minute % 60:02d}"


def normal_end_min(req: DispatchRequest) -> int:
    """The end of the normal day: the latest any truck may be back at the depot without a lever (depot closing,
    latest return). Each truck's own shift limit (its first departure + shift maximum) applies on top of it
    (second_shifts): a truck that leaves late may legally be back after shift start + shift maximum."""
    cfg = req.config
    end = req.depot.close_min or DAY_MIN
    return min(end, cfg.latest_return_min) if cfg.latest_return_min is not None else end


# ----------------------------------------------------------------------------------------------------------
# Evidence from the owner's IVMS report and the 13 Oct truck evidence (data/ivms_aggregates.json)
# ----------------------------------------------------------------------------------------------------------

def _load_aggregates(source: dict | str | Path | None) -> dict:
    """The aggregates: a dict as given, a path read if the file exists, or {} (none)."""
    if isinstance(source, dict):
        return source
    if source is not None and Path(source).is_file():
        return ivms.load(source)
    return {}


def _fleet_row(agg: dict, parameter: str) -> str | None:
    """One row of the 13 Oct "Fleet parameters" sheet as text, found by the start of its parameter name."""
    rows = ((agg.get("evidence_2026_10_12") or {}).get("fleet_parameters") or {}).get("rows") or []
    for r in rows:
        if str(r.get("parameter") or "").startswith(parameter):
            return f"{r['parameter']}: {r.get('value_to_use')} ({r.get('label')})"
    return None


@dataclass(frozen=True)
class SpeedFactors:
    """Truck speed in the extra hours relative to the day hours the engine's one time matrix stands for: the
    median IVMS speed of the hour band over the segment-weighted mean of the 06:00-18:00 band medians, at most 1."""

    evening: float  # legs starting 18:00-22:00
    night: float  # legs starting 22:00-06:00
    basis: str

    @classmethod
    def from_aggregates(cls, agg: dict, region: str = SPEED_REGION) -> "SpeedFactors | None":
        """From the IVMS MOVING-segment speeds of ``region`` by hour band, else of every region; None when a
        band has fewer than ivms.MIN_TIER_N segments."""
        speeds = (agg.get("ivms_raw") or {}).get("travel_speed_kmh") or {}
        sources = ((f"IVMS MOVING segments, {region}", (speeds.get("by_region_band") or {}).get(region)),
                   ("IVMS MOVING segments, all regions", speeds.get("by_band")))
        for source, bands in sources:
            need = DAY_BANDS + (EVENING_BAND, NIGHT_BAND)
            if not bands or any((bands.get(b) or {}).get("n", 0) < ivms.MIN_TIER_N for b in need):
                continue
            n_day = sum(bands[b]["n"] for b in DAY_BANDS)
            day = sum(bands[b]["p50"] * bands[b]["n"] for b in DAY_BANDS) / n_day
            evening, night = (min(1.0, round(bands[b]["p50"] / day, 3)) for b in (EVENING_BAND, NIGHT_BAND))
            basis = (f"{source} ({speeds.get('filter', 'MOVING segments')}): median km/h 06-18 {day:.1f} "
                     f"(segment-weighted mean of the band medians, n={n_day}), "
                     f"18-22 {bands[EVENING_BAND]['p50']} (n={bands[EVENING_BAND]['n']}), "
                     f"22-06 {bands[NIGHT_BAND]['p50']} (n={bands[NIGHT_BAND]['n']})")
            cross = _fleet_row(agg, "Time-of-day factor")
            if cross:
                basis += f". Cross-check, 13 Oct truck evidence: {cross}"
            return cls(evening=evening, night=night, basis=basis)
        return None

    def at(self, minute: int) -> float:
        """The factor of a leg that starts at ``minute`` of the day (1.0 in the day bands)."""
        hour = (minute // 60) % 24
        if 18 <= hour < 22:
            return self.evening
        return self.night if hour >= 22 or hour < 6 else 1.0


def unloading_gap(agg: dict) -> dict | None:
    """How much shorter a best-quartile visit is than the median one: 1 - p25 / p50 of time on site per chain
    (13 Oct GPS evidence, 'Claims check'), the visit-weighted median over chains with at least ivms.MIN_TIER_N
    visits. A spread across visits, not a measured crew effect: it is the basis FasterUnloading quotes, and
    that lever still requires evidence."""
    chains = (((agg.get("evidence_2026_10_12") or {}).get("chain_unloading") or {}).get("chains") or [])
    pairs = sorted((1 - r["p25_min"] / r["p50_min"], int(r["n_visits"])) for r in chains
                   if (r.get("n_visits") or 0) >= ivms.MIN_TIER_N and (r.get("p50_min") or 0) > 0 and r.get("p25_min"))
    total = sum(n for _, n in pairs)
    seen = 0
    for gap, n in pairs:
        seen += n
        if 2 * seen >= total:
            return {"p25_below_p50": round(gap, 3), "chains": len(pairs), "visits": total,
                    "basis": "13 Oct GPS evidence: time on site per chain, visit-weighted median of 1 - p25/p50"}
    return None


def ivms_evidence(agg: dict) -> dict:
    """The figures of the owner's IVMS report and the 13 Oct truck evidence that the what-ifs use or quote."""
    if not agg:
        return {}
    shape = (agg.get("ivms_raw") or {}).get("day_shape") or {}
    last = shape.get("last_stop_end") or {}
    out: dict = {
        "source": f"IVMS report {(agg.get('ivms_raw') or {}).get('period', '')}, "
                  f"{(agg.get('ivms_raw') or {}).get('rows', '?')} segments (aggregates only)",
        "unloading_gap": unloading_gap(agg),
        "reload": _fleet_row(agg, "Reload between loads"),
        "latest_return": _fleet_row(agg, "Latest return to depot"),
        "ivms_last_stop_end": {k: last[k]["hhmm"] for k in ("p50", "p75", "p90") if isinstance(last.get(k), dict)},
    }
    speed = SpeedFactors.from_aggregates(agg)
    if speed is not None:
        out["speed"] = {"evening": speed.evening, "night": speed.night, "basis": speed.basis}
    return out


# ----------------------------------------------------------------------------------------------------------
# What the levers may know about a day
# ----------------------------------------------------------------------------------------------------------

def _second_driver_cost(req: DispatchRequest, given: float | None) -> tuple[float, str]:
    if given is not None:
        return float(given), "ASSUMPTION given by the caller"
    rates = sorted(t.driver_day_cost for t in req.trucks if t.driver_day_cost is not None)
    if rates:
        median = float(rates[len(rates) // 2])
        return median, f"ASSUMPTION: the request's day rate of a day-paid driver ({len(rates)} trucks)"
    return DEFAULT_SECOND_DRIVER_OMR, "ASSUMPTION: the web's default daily driver day rate (hire.ts); the request has none"


def _derived_base(s: DispatchStop, per_case: float) -> float:
    """A stop's fixed unloading minutes when only its total is known: service - per case x cases, in [0, service]."""
    return min(float(s.service_min), max(0.0, s.service_min - per_case * s.demand_cases))


def faster_service_min(s: DispatchStop, per_case: float, share: float, base: float | None = None) -> int:
    """The stop's service minutes with its per-case part ``share`` (0-1) faster: the per-case part is per case x
    cases, at most what today's service has beyond its fixed ``base`` (None: derived, service - per case x
    cases). The new total is rounded half up like the web, never below the base and never above today's time.
    The one rule of FasterUnloading in whatif and explain (REQUIRES EVIDENCE)."""
    base = _derived_base(s, per_case) if base is None else base
    part = min(per_case * s.demand_cases, max(0.0, s.service_min - base))
    faster = math.floor(s.service_min - share * part + 0.5)
    return min(s.service_min, max(math.ceil(base - 1e-9), faster))


@dataclass(frozen=True)
class WhatIfContext:
    """What the levers know about a day beyond its request. Every map is keyed by stop_id; a stop missing from
    ``window_provenance`` counts as UNKNOWN."""

    window_provenance: dict[str, str]
    accepts_afternoon: dict[str, bool]
    accepts_night: dict[str, bool]
    genuine_hours: dict[str, tuple[int, int]]  # real opening hours, where known
    per_case_min: float  # unloading minutes per case (service = base + per case x cases)
    base_min_by_stop: dict[str, float]  # fixed unloading minutes per stop
    night_driver_cost: float  # OMR per truck-day that works past the normal shift (a second driver; ASSUMPTION)
    speed: SpeedFactors | None = None  # IVMS speed in the extra hours (None: not checked)
    evidence: dict = field(default_factory=dict)  # IVMS / truck-evidence figures the report quotes
    assumptions: dict[str, dict] = field(default_factory=dict)
    label: str = ""

    @classmethod
    def from_synth(cls, day: SynthDay, *, night_driver_cost: float | None = None,
                   aggregates: dict | str | Path | None = ivms.DEFAULT_OUT) -> "WhatIfContext":
        """The generated labels of a synthetic day; unloading = the generator's own type base + 0.25 x cases."""
        return cls._build(
            day.request, window_provenance=dict(day.window_provenance), accepts_afternoon=dict(day.accepts_afternoon),
            accepts_night=dict(day.accepts_night), genuine_hours=dict(day.genuine_hours),
            per_case_min=synth.SERVICE_PER_CASE,
            base_min_by_stop={sid: float(synth.TYPES[t].base_min) for sid, t in day.customer_type.items()},
            night_driver_cost=night_driver_cost, aggregates=aggregates,
            label=f"{day.label} {day.profile} day, {len(day.invoice_stop)} invoices, seed {day.seed}",
            provenance_basis="the generator's labels (SYNTHETIC)",
            base_basis="the generator's customer-type base (synth.TYPES)")

    @classmethod
    def from_real(cls, day: RealDay | DispatchRequest, *, per_case_min: float = synth.SERVICE_PER_CASE,
                  night_driver_cost: float | None = None,
                  aggregates: dict | str | Path | None = ivms.DEFAULT_OUT) -> "WhatIfContext":
        """A real day (history.load_real, or a bare request): every window UNKNOWN, no customer known to accept
        afternoon or night deliveries, and each stop's base unloading derived as service - per case x cases
        (clamped to [0, service])."""
        if not isinstance(day, RealDay):
            day = RealDay(request=day, window_provenance={s.stop_id: UNKNOWN for s in day.stops
                                                          if s.hard_start_min is not None or s.hard_end_min is not None},
                          accepts_afternoon={}, accepts_night={}, genuine_hours={}, source="", digest=core.digest(day),
                          label="REAL request")
        return cls._build(
            day.request, window_provenance=dict(day.window_provenance), accepts_afternoon=dict(day.accepts_afternoon),
            accepts_night=dict(day.accepts_night), genuine_hours=dict(day.genuine_hours), per_case_min=per_case_min,
            base_min_by_stop={s.stop_id: _derived_base(s, per_case_min) for s in day.request.stops},
            night_driver_cost=night_driver_cost, aggregates=aggregates, label=day.label,
            provenance_basis="RouteIQ records none: every window UNKNOWN",
            base_basis="derived: service - per case x cases, clamped to [0, service]")

    @classmethod
    def _build(cls, req: DispatchRequest, *, night_driver_cost: float | None, aggregates: dict | str | Path | None,
               provenance_basis: str, base_basis: str, **labels) -> "WhatIfContext":
        """The context with its second-driver price, IVMS speed and evidence, and every assumption listed."""
        cost, cost_basis = _second_driver_cost(req, night_driver_cost)
        agg = _load_aggregates(aggregates)
        speed = SpeedFactors.from_aggregates(agg) if agg else None
        assumptions = {
            "window_provenance": {"value": None, "basis": provenance_basis},
            "per_case_min": {"value": labels["per_case_min"],
                             "basis": "14 Oct benchmark; 13 Oct drop-size model 0.243-0.245 per case"},
            "base_min": {"value": None, "basis": base_basis},
            "night_driver_cost": {"value": cost, "basis": cost_basis + ". Added once per truck-day back after the "
                                  "normal shift end, on top of the engine's own hourly and overtime pay for those hours "
                                  "(conservative: part of that pay may count twice)"},
            "extra_hours_speed": {"value": None if speed is None else {"evening": speed.evening, "night": speed.night},
                                  "basis": "no IVMS aggregates: not checked" if speed is None else speed.basis},
        }
        return cls(night_driver_cost=cost, speed=speed, evidence=ivms_evidence(agg), assumptions=assumptions, **labels)


# ----------------------------------------------------------------------------------------------------------
# Levers
# ----------------------------------------------------------------------------------------------------------

def _movable(ctx: WhatIfContext, stop_id: str, hypothetical: bool) -> bool:
    """A window a lever may move: SALES_PREFERENCE, or UNKNOWN in a HYPOTHETICAL variant. Never CUSTOMER_HARD."""
    p = ctx.window_provenance.get(stop_id, UNKNOWN)
    return p == SALES_PREFERENCE or (hypothetical and p == UNKNOWN)


class Lever:
    """A change to a day's request. ``requires_evidence``: it assumes the work gets faster (never a baseline).
    ``hypothetical``: it also moves UNKNOWN windows (needs confirmation that they are preferences)."""

    requires_evidence: ClassVar[bool] = False
    hypothetical: bool = False

    @property
    def kind(self) -> str:
        return type(self).__name__

    @property
    def strength(self) -> float:
        """How far the lever goes, to pick the strongest of a kind for the all-levers combinations."""
        return 1.0

    @property
    def name(self) -> str:
        raise NotImplementedError

    def change(self, out: DispatchRequest, ctx: WhatIfContext, normal_end: int) -> None:
        """Apply the lever to ``out`` in place (a copy made by apply_levers)."""
        raise NotImplementedError

    def apply(self, req: DispatchRequest, ctx: WhatIfContext) -> DispatchRequest:
        """A copy of ``req`` with this lever applied (apply_levers)."""
        return apply_levers(req, [self], ctx)

    def _suffix(self) -> str:
        return ", HYPOTHETICAL" if self.hypothetical else ""


@dataclass(frozen=True)
class Flex(Lever):
    """hard_end_min + minutes on movable windows (the latest arrival under the START rule, the latest finish under
    FINISH), up to the genuine hours' end when known."""

    minutes: int
    hypothetical: bool = False

    def __post_init__(self) -> None:
        if not 1 <= self.minutes <= 240:
            raise ValueError("Flex minutes must be 1..240")

    @property
    def strength(self) -> float:
        return self.minutes

    @property
    def name(self) -> str:
        return f"Flex(+{self.minutes} min{self._suffix()})"

    def change(self, out: DispatchRequest, ctx: WhatIfContext, normal_end: int) -> None:
        for s in out.stops:
            if s.hard_end_min is not None and _movable(ctx, s.stop_id, self.hypothetical):
                g = ctx.genuine_hours.get(s.stop_id)
                s.hard_end_min = max(s.hard_end_min, min(s.hard_end_min + self.minutes, g[1] if g else DAY_MIN))


@dataclass(frozen=True)
class WidenPreference(Lever):
    """A movable window widened to the customer's genuine hours, or by 60 minutes on each side when unknown."""

    hypothetical: bool = False

    @property
    def name(self) -> str:
        return f"WidenPreference(genuine hours or +-60 min{self._suffix()})"

    def change(self, out: DispatchRequest, ctx: WhatIfContext, normal_end: int) -> None:
        for s in out.stops:
            if (s.hard_start_min is None and s.hard_end_min is None) or not _movable(ctx, s.stop_id, self.hypothetical):
                continue
            g = ctx.genuine_hours.get(s.stop_id)
            if s.hard_start_min is not None:
                s.hard_start_min = max(0, min(s.hard_start_min, g[0] if g else s.hard_start_min - 60))
            if s.hard_end_min is not None:
                s.hard_end_min = min(DAY_MIN, max(s.hard_end_min, g[1] if g else s.hard_end_min + 60))


@dataclass(frozen=True)
class PrefFlex(Lever):
    """pref_end_min + minutes on every stop with a preferred end: soft, it moves only ARTIFICIAL penalties."""

    minutes: int

    def __post_init__(self) -> None:
        if not 1 <= self.minutes <= 240:
            raise ValueError("PrefFlex minutes must be 1..240")

    @property
    def strength(self) -> float:
        return self.minutes

    @property
    def name(self) -> str:
        return f"PrefFlex(+{self.minutes} min)"

    def change(self, out: DispatchRequest, ctx: WhatIfContext, normal_end: int) -> None:
        for s in out.stops:
            if s.pref_end_min is not None:
                s.pref_end_min = min(DAY_MIN, s.pref_end_min + self.minutes)


@dataclass(frozen=True)
class _Extension(Lever):
    """Deliveries until ``until_min`` for customers flagged by ``flag``: their movable windows end at until_min
    (at most their genuine hours' end; read like any closing time under the request's window rule). When
    until_min is after the normal day's end (normal_end_min), the truck day runs to until_min too (a second
    driver shift: shift maximum, latest return, depot closing and the availability of every own truck that works
    the whole normal shift); trucks available for part of the day and rented-truck options (hire_candidate) keep
    their hours, and every customer not flagged is served inside the normal shift (apply_levers). Breaks stay as
    they are (the engine has one break per truck-day: the second driver's own break is not modelled)."""

    until_min: int = DEFAULT_AFTERNOON_UNTIL
    hypothetical: bool = False
    flag: ClassVar[str] = ""

    def __post_init__(self) -> None:
        if not 0 < self.until_min <= DAY_MIN:
            raise ValueError("until_min must be 1..1440 (the depot closes by the end of the day)")

    @property
    def strength(self) -> float:
        return self.until_min

    @property
    def name(self) -> str:
        return f"{self.kind}(until {_hhmm(self.until_min)}{self._suffix()})"

    def flagged(self, ctx: WhatIfContext, stop_id: str) -> bool:
        return bool(getattr(ctx, self.flag).get(stop_id))

    def change(self, out: DispatchRequest, ctx: WhatIfContext, normal_end: int) -> None:
        for s in out.stops:
            if s.hard_end_min is not None and self.flagged(ctx, s.stop_id) and _movable(ctx, s.stop_id, self.hypothetical):
                g = ctx.genuine_hours.get(s.stop_id)
                s.hard_end_min = max(s.hard_end_min, min(self.until_min, g[1] if g else DAY_MIN))
        if self.until_min <= normal_end:
            return
        cfg = out.config
        cfg.shift_max_min = max(cfg.shift_max_min, min(DAY_MIN, self.until_min - cfg.shift_start_min))
        if cfg.latest_return_min is not None:
            cfg.latest_return_min = max(cfg.latest_return_min, self.until_min)
        if out.depot.close_min:
            out.depot.close_min = max(out.depot.close_min, self.until_min)
        for t in out.trucks:
            if t.hire_candidate:
                t.available_to_min = min(t.available_to_min or normal_end, normal_end)
            elif t.available_to_min is not None and t.available_to_min >= normal_end:
                t.available_to_min = max(t.available_to_min, self.until_min)


@dataclass(frozen=True)
class Afternoon(_Extension):
    """Afternoon deliveries for customers flagged accepts_afternoon (see _Extension)."""

    until_min: int = DEFAULT_AFTERNOON_UNTIL
    flag: ClassVar[str] = "accepts_afternoon"


@dataclass(frozen=True)
class Night(_Extension):
    """Night deliveries for customers flagged accepts_night (see _Extension)."""

    until_min: int = DEFAULT_NIGHT_UNTIL
    flag: ClassVar[str] = "accepts_night"


@dataclass(frozen=True)
class FasterUnloading(Lever):
    """The per-case part of unloading pct % faster (faster_service_min with share pct / 100). REQUIRES
    EVIDENCE."""

    pct: float  # a percentage, 1..99 (not a share)
    requires_evidence: ClassVar[bool] = True

    def __post_init__(self) -> None:
        if not 1 <= self.pct < 100:
            raise ValueError("FasterUnloading pct is a percentage: 1 to under 100 (0.39 would be 0.39 %, not 39 %)")

    @property
    def strength(self) -> float:
        return self.pct

    @property
    def name(self) -> str:
        return f"FasterUnloading(-{self.pct:g}% per case)"

    def change(self, out: DispatchRequest, ctx: WhatIfContext, normal_end: int) -> None:
        for s in out.stops:
            s.service_min = faster_service_min(s, ctx.per_case_min, self.pct / 100, ctx.base_min_by_stop.get(s.stop_id))


@dataclass(frozen=True)
class FasterReload(Lever):
    """The depot turnaround between loads (reload_min) shorter by ``minutes``, at least 0. REQUIRES EVIDENCE."""

    minutes: int
    requires_evidence: ClassVar[bool] = True

    def __post_init__(self) -> None:
        if not 1 <= self.minutes <= 240:
            raise ValueError("FasterReload minutes must be 1..240")

    @property
    def strength(self) -> float:
        return self.minutes

    @property
    def name(self) -> str:
        return f"FasterReload(-{self.minutes} min)"

    def change(self, out: DispatchRequest, ctx: WhatIfContext, normal_end: int) -> None:
        out.config.reload_min = max(0, out.config.reload_min - self.minutes)


def _extensions_past(levers: Iterable[Lever], normal_end: int) -> list[_Extension]:
    return [lv for lv in levers if isinstance(lv, _Extension) and lv.until_min > normal_end]


def apply_levers(req: DispatchRequest, levers: Iterable[Lever], ctx: WhatIfContext) -> DispatchRequest:
    """A copy of ``req`` with every lever applied (``req`` is untouched), checked by ``guard``. At most one lever
    per kind. The result does not depend on the order: extensions only move ends later, and the customers kept
    inside the normal shift are decided once, from every Afternoon / Night lever together (a stop may be served
    until the latest until_min of the levers that flag it, else until the normal shift end)."""
    levers = list(levers)
    kinds = [lv.kind for lv in levers]
    if len(set(kinds)) != len(kinds):
        raise ValueError(f"one lever per kind: {kinds}")
    normal_end = normal_end_min(req)
    out = req.model_copy(deep=True)
    for lv in levers:
        lv.change(out, ctx, normal_end)
    ext = _extensions_past(levers, normal_end)
    if ext:
        for s in out.stops:
            limit = max([normal_end] + [e.until_min for e in ext if e.flagged(ctx, s.stop_id)])
            if s.hard_start_min is not None and s.hard_start_min > limit:
                # Its hours begin after the time it may be served: no truck, as in the normal day.
                s.allowed_truck_ids = []
                s.allowed_trucks_label = "a truck after the normal shift (this customer has not accepted later deliveries)"
            elif s.hard_end_min is None or s.hard_end_min > limit:
                s.hard_end_min = limit
    guard(req, out, ctx, levers)
    return out


class GuardError(ValueError):
    """A variant would relax something no what-if may relax."""


_STOP_FREE = {"hard_start_min", "hard_end_min", "pref_end_min", "service_min", "allowed_truck_ids", "allowed_trucks_label"}
_CONFIG_FREE = {"reload_min", "shift_max_min", "latest_return_min"}


def _later(new: int | None, old: int | None) -> bool:
    """An end moved later (or removed)."""
    return old is not None and (new is None or new > old)


def _earlier(new: int | None, old: int | None) -> bool:
    """A start moved earlier (or removed)."""
    return old is not None and (new is None or new < old)


def _narrowed(old: DispatchStop, new: DispatchStop) -> bool:
    """A hard window that starts later or ends earlier (or gained a start or an end)."""
    later_start = new.hard_start_min is not None and (old.hard_start_min is None or new.hard_start_min > old.hard_start_min)
    earlier_end = new.hard_end_min is not None and (old.hard_end_min is None or new.hard_end_min < old.hard_end_min)
    return later_start or earlier_end


def guard(base: DispatchRequest, new: DispatchRequest, ctx: WhatIfContext, levers: Iterable[Lever]) -> None:
    """Raise GuardError when ``new`` relaxes anything the levers may not: a CUSTOMER_HARD window (ever), an
    UNKNOWN window (outside a HYPOTHETICAL variant), breaks, capacity, pallet fill, trips, allowed trucks,
    orders, costs; shift and return limits, depot hours and truck hours only grow with an extension past the
    normal shift; windows only narrow (customers kept in the normal shift) with such an extension; service and
    reload only shrink with their evidence levers; preferred ends only move later with PrefFlex."""
    levers = list(levers)
    kinds = {type(lv) for lv in levers}
    hyp = any(lv.hypothetical for lv in levers)
    ext = bool(_extensions_past(levers, normal_end_min(base)))
    bad: list[str] = []
    if new.depot.model_dump(exclude={"close_min"}) != base.depot.model_dump(exclude={"close_min"}) or \
            (new.depot.close_min != base.depot.close_min and not (ext and new.depot.close_min > base.depot.close_min)):
        bad.append("depot")
    cb, cn = base.config, new.config
    if cn.model_dump(exclude=_CONFIG_FREE) != cb.model_dump(exclude=_CONFIG_FREE):
        bad.append("a config field no lever may change")
    if cn.reload_min != cb.reload_min and (FasterReload not in kinds or cn.reload_min > cb.reload_min):
        bad.append("reload_min")
    for f in ("shift_max_min", "latest_return_min"):
        old, now = getattr(cb, f), getattr(cn, f)
        if old != now and not (ext and old is not None and now is not None and now > old):
            bad.append(f)
    if [t.id for t in new.trucks] != [t.id for t in base.trucks]:
        bad.append("trucks")
    for tb, tn in zip(base.trucks, new.trucks):
        if tn.model_dump(exclude={"available_to_min"}) != tb.model_dump(exclude={"available_to_min"}) or \
                (tn.available_to_min != tb.available_to_min and not ext):
            bad.append(f"truck {tb.id}")
    if [s.stop_id for s in new.stops] != [s.stop_id for s in base.stops]:
        bad.append("stops")
    for sb, sn in zip(base.stops, new.stops):
        sid = sb.stop_id
        if sn.model_dump(exclude=_STOP_FREE) != sb.model_dump(exclude=_STOP_FREE):
            bad.append(f"stop {sid}: a field no lever may change")
        if _earlier(sn.hard_start_min, sb.hard_start_min) or _later(sn.hard_end_min, sb.hard_end_min):
            p = ctx.window_provenance.get(sid, UNKNOWN)
            if not (p == SALES_PREFERENCE or (p == UNKNOWN and hyp)):
                bad.append(f"stop {sid}: a {p} window widened")
        if _narrowed(sb, sn) and not ext:
            bad.append(f"stop {sid}: window narrowed")
        if sn.allowed_truck_ids != sb.allowed_truck_ids and not (ext and sn.allowed_truck_ids == []):
            bad.append(f"stop {sid}: allowed trucks")
        if sn.service_min != sb.service_min and (FasterUnloading not in kinds or sn.service_min > sb.service_min):
            bad.append(f"stop {sid}: service_min")
        if sn.pref_end_min != sb.pref_end_min and (PrefFlex not in kinds or not _later(sn.pref_end_min, sb.pref_end_min)):
            bad.append(f"stop {sid}: pref_end_min")
    if bad:
        raise GuardError("; ".join(bad[:6]) + (f" (+{len(bad) - 6} more)" if len(bad) > 6 else ""))


def changes(base: DispatchRequest, new: DispatchRequest) -> dict:
    """What a variant changed, as counts (no stop ids)."""
    out = {"windows_widened": 0, "windows_narrowed": 0, "stops_without_truck": 0, "pref_ends_moved": 0,
           "service_reduced": 0, "service_min_saved": 0, "trucks_extended": 0, "config": {}}
    for sb, sn in zip(base.stops, new.stops):
        out["windows_widened"] += _earlier(sn.hard_start_min, sb.hard_start_min) or _later(sn.hard_end_min, sb.hard_end_min)
        out["windows_narrowed"] += _narrowed(sb, sn)
        out["stops_without_truck"] += sn.allowed_truck_ids == [] and sb.allowed_truck_ids != []
        out["pref_ends_moved"] += sn.pref_end_min != sb.pref_end_min
        out["service_reduced"] += sn.service_min < sb.service_min
        out["service_min_saved"] += sb.service_min - sn.service_min
    out["trucks_extended"] = sum(tb.available_to_min is not None and tn.available_to_min is not None
                                 and tn.available_to_min > tb.available_to_min for tb, tn in zip(base.trucks, new.trucks))
    for f in sorted(_CONFIG_FREE):
        if getattr(base.config, f) != getattr(new.config, f):
            out["config"][f] = [getattr(base.config, f), getattr(new.config, f)]
    if base.depot.close_min != new.depot.close_min:
        out["config"]["depot.close_min"] = [base.depot.close_min, new.depot.close_min]
    return out


# ----------------------------------------------------------------------------------------------------------
# Second driver and the extra hours' speed
# ----------------------------------------------------------------------------------------------------------

def second_shifts(base: DispatchRequest, sc: DispatchScenario) -> tuple[int, int, float]:
    """Truck-days of ``sc`` back after their normal end (``base`` is the request before any lever): the normal
    day's end, the truck's own first departure + shift maximum, or its availability, whichever is first. Also
    the minutes they work after it, and the engine's overtime pay (OMR, already in its cash) for those minutes."""
    cfg = base.config
    end_day = normal_end_min(base)
    trucks = {t.id: t for t in base.trucks}
    n, minutes, overtime = 0, 0, 0.0
    for d in sc.truck_days:
        t = trucks.get(d.truck_id)
        end = min(end_day, d.day_start_min + cfg.shift_max_min,
                  t.available_to_min if t is not None and t.available_to_min is not None else 2 * DAY_MIN)
        if d.last_return_min > end:
            n += 1
            minutes += d.last_return_min - end
            overtime += min(d.overtime_min, d.last_return_min - end) / 60 * cfg.overtime_cost_per_hour
    return n, minutes, round(overtime, 3)


def _latest_return(req: DispatchRequest, t: DispatchTruck, first_depart: int) -> int:
    cfg = req.config
    latest = min(req.depot.close_min or DAY_MIN, t.available_to_min or 2 * DAY_MIN, first_depart + cfg.shift_max_min)
    return min(latest, cfg.latest_return_min) if cfg.latest_return_min is not None else latest


def speed_check(req: DispatchRequest, sc: DispatchScenario, normal_end: int, speed: SpeedFactors) -> dict[str, int]:
    """The engine plans with one time matrix for the whole day, so the slower traffic of the extra hours is
    checked afterwards: every planned load is re-timed along its own stop order with the drive minutes of each
    leg that fall after ``normal_end`` slowed to the IVMS speed of their hour (minutes / SpeedFactors.at).
    Waiting absorbs delay, and a late return delays the truck's next load (reload and loading start on the
    later return). Returns the ``legs`` driven (wholly or partly) in the extra hours, the ``extra_drive_min``
    added, the ``late_stops`` whose unloading would then start (START rule) or finish (FINISH) after their
    window, and the ``late_returns`` of loads back after the truck's latest return."""
    cfg = req.config
    stops = {s.stop_id: s for s in req.stops}
    trucks = {t.id: t for t in req.trucks}
    out = {"legs": 0, "extra_drive_min": 0, "late_stops": 0, "late_returns": 0}

    def slower(leg: int, start: int) -> int:
        after = min(leg, start + leg - normal_end)  # the leg's drive minutes after the normal shift end
        if after <= 0:
            return 0
        f = speed.at(max(start, normal_end))
        extra = math.ceil(after / f - after - 1e-9) if f < 1 else 0
        out["legs"] += 1
        out["extra_drive_min"] += extra
        return extra

    by_truck: dict[str, list] = defaultdict(list)
    for ld in sc.loads:
        by_truck[ld.truck_id].append(ld)
    for tid, loads in by_truck.items():
        loads.sort(key=lambda ld: ld.load_no)
        latest = _latest_return(req, trucks[tid], loads[0].depart_min)
        back: int | None = None
        for ld in loads:
            t = ld.depart_min if back is None else \
                max(ld.depart_min, back + cfg.reload_min + math.ceil(cfg.loading_min_per_case * ld.cases))
            planned = ld.depart_min  # the planned departure from the previous point
            for st in ld.stops:
                start = max(st.arrival_min + (t - planned) + slower(st.leg_min, t), st.service_start_min)
                s = stops[st.stop_id]
                if s.hard_end_min is not None:
                    out["late_stops"] += start + (s.service_min if cfg.window_rule == "FINISH" else 0) > s.hard_end_min
                t, planned = start + (st.departure_min - st.service_start_min), st.departure_min
            back = ld.return_min + (t - planned) + slower(ld.return_min - planned, t)
            out["late_returns"] += back > latest
    return out


# ----------------------------------------------------------------------------------------------------------
# Running the variants
# ----------------------------------------------------------------------------------------------------------

def _strongest(levers: Iterable[Lever]) -> tuple[Lever, ...]:
    """The strongest lever of each kind (the first one on a tie), in the order the kinds first appear."""
    best: dict[str, Lever] = {}
    for lv in levers:
        if lv.kind not in best or lv.strength > best[lv.kind].strength:
            best[lv.kind] = lv
    return tuple(best.values())


def plan_variants(levers: Iterable[Lever], combos: bool = True) -> list[tuple[str, tuple[Lever, ...]]]:
    """(group, levers) of every variant: each lever alone (SINGLE); with ``combos``, every pair of levers of two
    different kinds that need no evidence (PAIR), the strongest of each such kind together (ALL) and, apart, the
    strongest of every kind including the evidence levers (ALL_WITH_EVIDENCE). A variant that is several of
    these is run once, its groups joined ("PAIR, ALL")."""
    levers = list(levers)
    names = [lv.name for lv in levers]
    if len(set(names)) != len(names):
        raise ValueError(f"duplicate levers: {names}")
    found: dict[frozenset[str], tuple[list[str], tuple[Lever, ...]]] = {}

    def add(group: str, combo: tuple[Lever, ...]) -> None:
        key = frozenset(lv.name for lv in combo)
        if key in found:
            found[key][0].append(group)
        else:
            found[key] = ([group], combo)

    for lv in levers:
        add("SINGLE", (lv,))
    if combos:
        plain = [lv for lv in levers if not lv.requires_evidence]
        for a, b in itertools.combinations(plain, 2):
            if a.kind != b.kind:
                add("PAIR", (a, b))
        if len(every := _strongest(plain)) > 1:
            add("ALL", every)
        with_evidence = _strongest(levers)
        if len(with_evidence) > 1 and any(lv.requires_evidence for lv in with_evidence):
            add("ALL_WITH_EVIDENCE", with_evidence)
    return [(", ".join(groups), combo) for groups, combo in found.values()]


def _stats(values: list[float]) -> dict:
    return {"mean": round(sum(values) / len(values), 4), "min": round(min(values), 4), "max": round(max(values), 4),
            "values": [round(v, 4) for v in values]}


def _recommended(run: RunResult) -> DispatchScenario:
    return next(sc for sc in run.response.scenarios if sc.name == "RECOMMENDED")


@dataclass
class WhatIfRow:
    """One variant over the budget's seeds. ``delta`` = core.diff against the baseline (paired per seed);
    ``cash`` adds the second-driver assumption to the engine's cash; penalties stay ARTIFICIAL."""

    name: str
    group: str
    levers: tuple[str, ...]
    requires_evidence: bool
    hypothetical: bool
    changes: dict
    summary: dict  # core.summarize of its runs, lateness against the day's own windows (_with_windows_of)
    delta: dict | None  # core.diff(baseline, this); None for the baseline
    cash: dict  # per seed: engine cash + second shifts x ctx.night_driver_cost (OMR)
    delta_cash: dict | None
    second_driver: dict  # shifts, minutes_after_normal, omr (in cash), overtime_after_normal_omr (engine overtime then)
    speed_check: dict | None  # IVMS re-timing of the extra hours (speed_check), when the variant has them
    feasibility: list[str]
    status: list[str]
    runs: list[RunResult] = field(default_factory=list, repr=False)

    @property
    def flags(self) -> list[str]:
        return [f for f, on in (("HYPOTHETICAL", self.hypothetical), ("REQUIRES EVIDENCE", self.requires_evidence)) if on]

    def to_dict(self) -> dict:
        """Everything but the runs (requests and responses with ids), JSON-ready."""
        return {f.name: getattr(self, f.name) for f in fields(self) if f.name != "runs"} | {"flags": self.flags}


_WINDOW_FIELDS = ("hard_start_min", "hard_end_min", "pref_start_min", "pref_end_min")


def _with_windows_of(req: DispatchRequest, base: DispatchRequest) -> DispatchRequest:
    """``req`` (a variant as solved) with the hard and preferred windows the day had before any lever. Its
    other changes (service times, shift) stay: measured against it, a plan's late stops and minutes outside
    preferred windows are those of the day's own windows, not of the windows a lever moved."""
    before = {s.stop_id: s for s in base.stops}
    return req.model_copy(update={"stops": [s.model_copy(update={f: getattr(before[s.stop_id], f) for f in _WINDOW_FIELDS})
                                            for s in req.stops]})


def _row(name: str, group: str, combo: tuple[Lever, ...], base_req: DispatchRequest, req: DispatchRequest,
         runs: list[RunResult], baseline: WhatIfRow | None, ctx: WhatIfContext) -> WhatIfRow:
    normal_end = normal_end_min(base_req)
    # Every figure as the engine reports it, but lateness against the day's own windows (Flex and PrefFlex are
    # not free: a stop served in its widened window is late against the window it had).
    summary = core.summarize([replace(r, metrics=core.metrics(_with_windows_of(r.request, base_req), _recommended(r)))
                              for r in runs])
    shifts = [second_shifts(base_req, _recommended(r)) for r in runs]
    cash = [r.metrics.cash.total + n * ctx.night_driver_cost for r, (n, _, _) in zip(runs, shifts)]
    check = None
    if ctx.speed is not None and _extensions_past(combo, normal_end):
        per_run = [speed_check(r.request, _recommended(r), normal_end, ctx.speed) for r in runs]
        check = {k: _stats([c[k] for c in per_run]) for k in per_run[0]}
    return WhatIfRow(
        name=name, group=group, levers=tuple(lv.name for lv in combo),
        requires_evidence=any(lv.requires_evidence for lv in combo), hypothetical=any(lv.hypothetical for lv in combo),
        changes=changes(base_req, req), summary=summary,
        delta=core.diff(baseline.summary, summary) if baseline else None, cash=_stats(cash),
        delta_cash=_stats([c - b for c, b in zip(cash, baseline.cash["values"])]) if baseline else None,
        second_driver={"shifts": _stats([n for n, _, _ in shifts]),
                       "minutes_after_normal": _stats([m for _, m, _ in shifts]),
                       "omr": _stats([n * ctx.night_driver_cost for n, _, _ in shifts]),
                       "overtime_after_normal_omr": _stats([o for _, _, o in shifts])},
        speed_check=check, feasibility=[r.metrics.feasibility for r in runs], status=[r.metrics.status for r in runs],
        runs=runs,
    )


def run_whatif(req: DispatchRequest, levers: Iterable[Lever], budget: Budget, ctx: WhatIfContext,
               combos: bool = True) -> "WhatIfReport":
    """The baseline and every variant of ``plan_variants`` solved with the same ``budget`` (time, mode, seeds),
    one run at a time. Every variant passes ``guard`` before the first solve."""
    normal_end = normal_end_min(req)
    prepared = [(group, combo, apply_levers(req, combo, ctx)) for group, combo in plan_variants(levers, combos)]
    baseline = _row("Baseline", "BASELINE", (), req, req, core.solve_seeds(req, budget), None, ctx)
    rows = [_row(" + ".join(lv.name for lv in combo), group, combo, req, vreq, core.solve_seeds(vreq, budget), baseline, ctx)
            for group, combo, vreq in prepared]
    return WhatIfReport(label=ctx.label, digest=core.digest(req), budget=budget, normal_end_min=normal_end,
                        night_driver_cost=ctx.night_driver_cost, baseline=baseline, rows=rows,
                        assumptions=dict(ctx.assumptions), evidence=dict(ctx.evidence))


# ----------------------------------------------------------------------------------------------------------
# Report
# ----------------------------------------------------------------------------------------------------------

def _num(v: float, nd: int, signed: bool) -> str:
    return f"{v:+.{nd}f}" if signed else f"{v:.{nd}f}"


def _fmt(st: dict | None, nd: int = 2, signed: bool = True) -> str:
    """mean [min..max] over the seeds (just the mean when they agree)."""
    if not st:
        return "-"
    if st["min"] == st["max"]:
        return _num(st["mean"], nd, signed)
    return f"{_num(st['mean'], nd, signed)} [{_num(st['min'], nd, signed)}..{_num(st['max'], nd, signed)}]"


def _count(items: list[str]) -> str:
    return ", ".join(f"{k} x{n}" for k, n in sorted(Counter(items).items()))


@dataclass
class WhatIfReport:
    """The baseline and the variants of one day, with the assumptions and the IVMS evidence they rest on."""

    label: str
    digest: str
    budget: Budget
    normal_end_min: int
    night_driver_cost: float
    baseline: WhatIfRow
    rows: list[WhatIfRow]
    assumptions: dict
    evidence: dict
    labels: dict = field(default_factory=lambda: dict(core.LABELS))

    def to_dict(self) -> dict:
        """JSON-ready, without stop ids or coordinates."""
        return {"label": self.label, "digest": self.digest, "budget": asdict(self.budget),
                "normal_end_min": self.normal_end_min, "night_driver_cost": self.night_driver_cost,
                "baseline": self.baseline.to_dict(), "rows": [r.to_dict() for r in self.rows],
                "assumptions": self.assumptions, "evidence": self.evidence, "labels": self.labels}

    def _table(self, rows: list[WhatIfRow]) -> list[str]:
        out = ["| Variant | Group | Flags | Δ cash OMR | Δ stops served | Δ cases served | Δ trucks | Δ trips | "
               "Δ est. km | Δ late stops | Δ proven impossible | Feasibility (per run) |",
               "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in rows:
            d = r.delta["metrics"]  # type: ignore[index]
            flags = r.flags + (["2nd driver"] if r.second_driver["shifts"]["max"] > 0 else [])
            out.append(f"| {r.name} | {r.group} | {', '.join(flags) or '-'} | {_fmt(r.delta_cash)} | "
                       f"{_fmt(d['stops_served'], 1)} | {_fmt(d['cases_served'], 0)} | {_fmt(d['trucks_used'], 1)} | "
                       f"{_fmt(d['trips'], 1)} | {_fmt(d['km'], 1)} | {_fmt(d['late_stops'], 1)} | "
                       f"{_fmt(d['proven_impossible'], 1)} | {_count(r.feasibility)} |")
        return out

    def to_markdown(self) -> str:
        b, m = self.budget, self.baseline.summary["metrics"]
        lines = [
            f"# What-if and sensitivity: {self.label}", "",
            f"Budget: {b.time_limit_sec} s per run, {b.search_mode}, seeds {list(b.seeds)}, RECOMMENDED only, one run "
            f"at a time; request digest {self.digest}. Plans are the best found in that time, not proven optimal. "
            f"Normal day end (latest return or depot closing) {_hhmm(self.normal_end_min)}; each truck's own shift "
            f"limit (first departure + shift maximum) applies too.", "",
            f"**Baseline:** cash {_fmt(self.baseline.cash, 2, False)} OMR; stops served "
            f"{_fmt(m['stops_served'], 1, False)} of {m['stops_total']['mean']:.0f}; "
            f"cases {_fmt(m['cases_served'], 0, False)} of {m['cases_total']['mean']:.0f}; "
            f"trucks {_fmt(m['trucks_used'], 1, False)}; trips {_fmt(m['trips'], 1, False)}; "
            f"{_fmt(m['km'], 1, False)} estimated km; proven impossible {_fmt(m['proven_impossible'], 1, False)}; "
            f"feasibility {_count(self.baseline.feasibility)}.", "",
            "Every Δ is variant minus baseline, paired per seed: mean [min..max] over the seeds. Cash includes the "
            "second-driver assumption where a truck works past the normal shift. Serving more stops usually costs "
            "more cash: read Δ cash together with Δ stops served. The baseline's own spread over the seeds is the "
            "search noise at this budget: a Δ whose range spans 0 is not established. Late stops and minutes outside "
            "preferred windows count against the day's own windows, before any lever moved them; the ARTIFICIAL "
            "window penalty is the solver's own, for the windows it was given.", "",
        ]
        plain = [r for r in self.rows if not r.requires_evidence]
        evidence = [r for r in self.rows if r.requires_evidence]
        if plain:
            lines += ["## Levers that need no new evidence", "", *self._table(plain), ""]
        if evidence:
            lines += ["## Operational improvement potential (REQUIRES EVIDENCE, never a baseline)", "",
                      *self._table(evidence), ""]
        lines += ["## Time and ARTIFICIAL solver penalties (not cash)", "",
                  "| Variant | Δ paid driver min | Δ min outside preferred windows | Δ window penalty (ARTIFICIAL) | "
                  "Δ unserved penalty (ARTIFICIAL) | 2nd-driver shifts | their min after the normal end | 2nd-driver OMR "
                  "(in cash) | engine overtime after the normal end OMR (in cash) |",
                  "|---|---|---|---|---|---|---|---|---|"]
        for r in self.rows:
            d = r.delta["metrics"]  # type: ignore[index]
            sd = r.second_driver
            lines.append(f"| {r.name} | {_fmt(d['paid_driver_min'], 0)} | {_fmt(d['minutes_outside_pref'], 0)} | "
                         f"{_fmt(d['penalties.window'])} | {_fmt(d['penalties.unserved_penalty'], 0)} | "
                         f"{_fmt(sd['shifts'], 1, False)} | {_fmt(sd['minutes_after_normal'], 0, False)} | "
                         f"{_fmt(sd['omr'], 2, False)} | "
                         f"{_fmt(sd['overtime_after_normal_omr'], 2, False)} |")
        lines.append("")
        checked = [r for r in self.rows if r.speed_check]
        if checked:
            lines += ["## Extra hours at the IVMS evening / night speed", "",
                      "The engine has one time matrix for the whole day. Each plan below was re-timed with the drive "
                      "minutes after the normal shift end slowed to the IVMS speed of their hour; stops or returns "
                      "that would then be late are counted (the plan's own figures above do not include this).", "",
                      "| Variant | legs in the extra hours | extra drive min | stops late at IVMS speed | "
                      "loads back late |", "|---|---|---|---|---|"]
            for r in checked:
                c = r.speed_check  # type: ignore[assignment]
                lines.append(f"| {r.name} | {_fmt(c['legs'], 1, False)} | {_fmt(c['extra_drive_min'], 0, False)} | "
                             f"{_fmt(c['late_stops'], 1, False)} | {_fmt(c['late_returns'], 1, False)} |")
            lines.append("")
        lines += ["## What each variant changed", "",
                  "| Variant | windows widened | windows narrowed (kept in the normal shift) | stops with no truck | "
                  "preferred ends moved | service times cut (min saved) | trucks' hours extended | config |",
                  "|---|---|---|---|---|---|---|---|"]
        for r in self.rows:
            c = r.changes
            cfg = "; ".join(f"{k} {v[0]}->{v[1]}" for k, v in c["config"].items()) or "-"
            lines.append(f"| {r.name} | {c['windows_widened']} | {c['windows_narrowed']} | {c['stops_without_truck']} | "
                         f"{c['pref_ends_moved']} | {c['service_reduced']} ({c['service_min_saved']}) | "
                         f"{c['trucks_extended']} | {cfg} |")
        lines += ["", "Never changed by any lever: CUSTOMER_HARD windows, breaks, capacity, pallet fill, trips, allowed "
                  "trucks (except the customers kept in the normal shift), orders and costs. UNKNOWN windows move only in "
                  "rows marked HYPOTHETICAL (needs confirmation that these are preferences).", "",
                  "## Assumptions", ""]
        for k, a in self.assumptions.items():
            lines.append(f"- {k}: " + (f"{a['value']}. " if a["value"] is not None else "") + a["basis"])
        if self.evidence:
            lines += ["", "## Evidence from the IVMS report and the 13 Oct truck evidence (aggregates only)", "",
                      f"- Source: {self.evidence.get('source')}"]
            if self.evidence.get("speed"):
                sp = self.evidence["speed"]
                lines.append(f"- Extra-hours speed factor: evening {sp['evening']}, night {sp['night']} "
                             f"(x day speed). {sp['basis']}")
            gap = self.evidence.get("unloading_gap")
            if gap:
                lines.append(f"- Unloading spread (basis of FasterUnloading, still REQUIRES EVIDENCE): the p25 visit is "
                             f"{gap['p25_below_p50']:.0%} shorter than the median ({gap['chains']} chains, "
                             f"{gap['visits']} visits; {gap['basis']}).")
            for key, text in (("reload", "Reload (basis of FasterReload, still REQUIRES EVIDENCE)"),
                              ("latest_return", "Latest return today")):
                if self.evidence.get(key):
                    lines.append(f"- {text}: {self.evidence[key]}")
            if self.evidence.get("ivms_last_stop_end"):
                last = self.evidence["ivms_last_stop_end"]
                lines.append("- IVMS last stop end per vehicle-day: " + ", ".join(f"{k} {v}" for k, v in last.items()))
        lines += ["", "Labels: " + "; ".join(f"{k}: {v}" for k, v in self.labels.items()), ""]
        return "\n".join(lines)
