"""Historical adapters (DESIGN.md section 1.3): real requests kept outside the repository, anonymous
labels, and the uncertainty model of actual travel and unloading times.

Real days live only on the codespace (``~/ds-data``). Nothing here writes them anywhere. Committed
results use ``anonymise`` (labels instead of ids) and never contain coordinates.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import NamedTuple

from dispatch_models import DispatchRequest

from . import core, ivms
from .synth import CUSTOMER_HARD, SALES_PREFERENCE, UNKNOWN

__all__ = ["CUSTOMER_HARD", "SALES_PREFERENCE", "UNKNOWN", "RealDay", "load_real", "anonymise", "Draw",
           "UncertaintyModel", "ivms_travel_sigma", "ivms_unload_sigma"]


@dataclass
class RealDay:
    """A real request with the labels the what-ifs need, in the same shape as synth.SynthDay. RouteIQ has
    no window provenance, so every window is UNKNOWN (treated as genuine; flexed only in a HYPOTHETICAL
    variant), and no customer is known to accept afternoon or night deliveries."""

    request: DispatchRequest
    window_provenance: dict[str, str]
    accepts_afternoon: dict[str, bool]
    accepts_night: dict[str, bool]
    genuine_hours: dict[str, tuple[int, int]]
    source: str  # the file name only
    digest: str
    assumptions: dict[str, dict] = field(default_factory=dict)
    label: str = "REAL (anonymise before committing anything)"

    def anonymised(self) -> "RealDay":
        """The same day with anonymous ids (``anonymise``); every per-stop map follows the new labels."""
        labels = core.label_stops(self.request)

        def relabel(d: dict) -> dict:
            return {labels[k]: v for k, v in d.items()}

        return RealDay(request=anonymise(self.request), window_provenance=relabel(self.window_provenance),
                       accepts_afternoon=relabel(self.accepts_afternoon), accepts_night=relabel(self.accepts_night),
                       genuine_hours=relabel(self.genuine_hours), source=self.source, digest=self.digest,
                       assumptions=dict(self.assumptions), label="REAL, anonymised (coordinates still in memory)")


def load_real(path: str | Path) -> RealDay:
    """A real request from a JSON file outside the repository, with UNKNOWN provenance for every window."""
    req = core.load_request(path)
    windowed = [s.stop_id for s in req.stops if s.hard_start_min is not None or s.hard_end_min is not None]
    return RealDay(
        request=req, window_provenance={sid: UNKNOWN for sid in windowed},
        accepts_afternoon={s.stop_id: False for s in req.stops}, accepts_night={s.stop_id: False for s in req.stops},
        genuine_hours={}, source=Path(path).name, digest=core.digest(req),
        assumptions={
            "window_provenance": {"value": UNKNOWN, "basis": "RouteIQ records no window provenance (DESIGN.md section 7)"},
            "accepts_afternoon_night": {"value": False, "basis": "not known for real customers"},
        },
    )


def anonymise(req: DispatchRequest) -> DispatchRequest:
    """A copy with anonymous ids: stops "stop-001" (core.label_stops), customers "cust-001", orders
    "ord-0001", trucks "truck-01", run and tenant "anon". Coordinates, sizes, windows and costs are kept in
    memory; committed results must still leave coordinates out."""
    stops = core.label_stops(req)
    customers = {c: f"cust-{i:03d}" for i, c in enumerate(sorted({s.customer_id for s in req.stops}), start=1)}
    orders = {o: f"ord-{i:04d}" for i, o in enumerate(sorted(o for s in req.stops for o in s.order_ids), start=1)}
    trucks = {t.id: f"truck-{i:02d}" for i, t in enumerate(req.trucks, start=1)}
    out = req.model_copy(deep=True)
    out.run_id, out.tenant_id, out.depot.id = "anon", "anon", "depot"
    out.config.osrm_url = None
    for t in out.trucks:
        t.id = t.code = trucks[t.id]
    for s in out.stops:
        s.stop_id, s.customer_id = stops[s.stop_id], customers[s.customer_id]
        s.order_ids = [orders[o] for o in s.order_ids]
        s.previous_truck_id = trucks.get(s.previous_truck_id) if s.previous_truck_id else None
        if s.allowed_truck_ids is not None:
            s.allowed_truck_ids = [trucks[t] for t in s.allowed_truck_ids if t in trucks]
    return out


class Draw(NamedTuple):
    """Multipliers of one stop's planned times: actual = planned x multiplier."""

    travel: float
    unload: float


# Defaults when nothing measured is available: ASSUMPTIONS, named in UncertaintyModel.assumed.
DEFAULT_TRAVEL = (1.0, 0.25)  # median multiplier, lognormal sigma
DEFAULT_UNLOAD = (1.0, 0.35)
SIGMA_BOUNDS = (0.05, 1.0)
MULTIPLIER_BOUNDS = (0.25, 4.0)  # a sampled multiplier is clipped to this range
IQR_Z = 1.349  # the interquartile range of a standard normal
MIN_BAND_VISITS = 5  # chain x drop-size rows with fewer visits are too thin for a spread


def _clip(x: float, lo_hi: tuple[float, float]) -> float:
    return min(max(x, lo_hi[0]), lo_hi[1])


def _gps_fit(actuals: dict | None, key: str) -> dict | None:
    """The lognormal fit of the GPS-confirmed plan-vs-actual rows, when there are enough of them."""
    ln = (((actuals or {}).get("gps") or {}).get(key) or {}).get("lognormal") or {}
    return ln if ln.get("n", 0) >= ivms.MIN_TIER_N and "median" in ln else None


def ivms_travel_sigma(agg: dict) -> tuple[float, int] | None:
    """The spread of drive times from the IVMS speeds of MOVING segments of 5 km or more: ln(p75 / p25) /
    1.349 (time = km / speed, so ln time has the spread of ln speed). Spread across roads and hours, so it
    is at most the spread of an estimate's error."""
    p = (((agg.get("ivms_raw") or {}).get("travel_speed_kmh") or {}).get("segments_5km_plus") or {})
    if p.get("n", 0) < ivms.MIN_TIER_N or not p.get("p25"):
        return None
    return round(math.log(p["p75"] / p["p25"]) / IQR_Z, 3), p["n"]


def ivms_unload_sigma(agg: dict) -> tuple[float, int] | None:
    """The spread of unloading minutes within a chain and drop size (13 Oct evidence, 'by_drop_size' rows
    with at least MIN_BAND_VISITS visits): the visit-weighted median of ln(p75 / p25) / 1.349."""
    rows = (((agg.get("evidence_2026_10_12") or {}).get("chain_unloading") or {}).get("by_drop_size") or [])
    pairs = sorted((math.log(r["p75_min"] / r["p25_min"]) / IQR_Z, int(r["n_visits"])) for r in rows
                   if (r.get("n_visits") or 0) >= MIN_BAND_VISITS and (r.get("p25_min") or 0) > 0)
    total = sum(n for _, n in pairs)
    if total < ivms.MIN_TIER_N:
        return None
    seen = 0
    for sigma, n in pairs:
        seen += n
        if 2 * seen >= total:
            return round(sigma, 3), total
    return None


@dataclass(frozen=True)
class UncertaintyModel:
    """Lognormal multipliers of planned travel and unloading minutes (median, sigma of ln). ``assumed``
    names the parameters that are defaults, not measured; ``basis`` says where each parameter comes from."""

    travel_median: float = DEFAULT_TRAVEL[0]
    travel_sigma: float = DEFAULT_TRAVEL[1]
    unload_median: float = DEFAULT_UNLOAD[0]
    unload_sigma: float = DEFAULT_UNLOAD[1]
    assumed: tuple[str, ...] = ("travel_median", "travel_sigma", "unload_median", "unload_sigma")
    basis: dict[str, str] = field(default_factory=lambda: {
        k: "DEFAULT ASSUMPTION" for k in ("travel_median", "travel_sigma", "unload_median", "unload_sigma")})

    @classmethod
    def defaults(cls) -> "UncertaintyModel":
        """The labelled default assumptions."""
        return cls()

    @classmethod
    def build(cls, actuals: dict | None, aggregates: dict | None = None) -> "UncertaintyModel":
        """Per parameter, the first available of: the GPS-confirmed 14 Oct plan-vs-actual rows (at least
        ivms.MIN_TIER_N), the IVMS / evidence spreads (sigmas only), the defaults."""
        values: dict[str, float] = {}
        basis: dict[str, str] = {}
        assumed: list[str] = []
        spreads = {"travel": ivms_travel_sigma(aggregates) if aggregates else None,
                   "unload": ivms_unload_sigma(aggregates) if aggregates else None}
        sources = {"travel": "IVMS speeds of 5 km+ segments", "unload": "13 Oct evidence, chain x drop size"}
        for kind, key, default in (("travel", "travel", DEFAULT_TRAVEL), ("unload", "unloading", DEFAULT_UNLOAD)):
            fit = _gps_fit(actuals, key)
            if fit is not None:
                values[f"{kind}_median"], values[f"{kind}_sigma"] = fit["median"], _clip(fit["sigma"], SIGMA_BOUNDS)
                basis[f"{kind}_median"] = basis[f"{kind}_sigma"] = f"14 Oct plan vs actual, GPS-confirmed rows, n={fit['n']}"
                continue
            values[f"{kind}_median"] = default[0]
            basis[f"{kind}_median"] = "DEFAULT ASSUMPTION (too few GPS-confirmed plan-vs-actual rows)"
            assumed.append(f"{kind}_median")
            if spreads[kind] is not None:
                values[f"{kind}_sigma"] = _clip(spreads[kind][0], SIGMA_BOUNDS)
                basis[f"{kind}_sigma"] = f"{sources[kind]}, n={spreads[kind][1]} (spread across visits: an upper bound)"
            else:
                values[f"{kind}_sigma"] = default[1]
                basis[f"{kind}_sigma"] = "DEFAULT ASSUMPTION"
                assumed.append(f"{kind}_sigma")
        return cls(**values, assumed=tuple(assumed), basis=basis)

    @classmethod
    def from_aggregates(cls, path: str | Path = ivms.DEFAULT_OUT) -> "UncertaintyModel":
        """From the committed aggregates (data/ivms_aggregates.json)."""
        agg = ivms.load(path)
        return cls.build(agg.get("actuals_2026_10_14"), agg)

    @classmethod
    def from_actuals(cls, path: str | Path) -> "UncertaintyModel":
        """Straight from a plan-vs-actual export (ivms.actuals_stats), e.g. ~/ds-data/day-2026-10-14-actuals.json."""
        return cls.build(ivms.actuals_stats(path))

    def _one(self, rnd: random.Random) -> Draw:
        travel = self.travel_median * math.exp(self.travel_sigma * rnd.gauss(0.0, 1.0))
        unload = self.unload_median * math.exp(self.unload_sigma * rnd.gauss(0.0, 1.0))
        return Draw(round(_clip(travel, MULTIPLIER_BOUNDS), 4), round(_clip(unload, MULTIPLIER_BOUNDS), 4))

    def sample(self, seed: int, n: int) -> list[Draw]:
        """``n`` draws for world ``seed``; the same (seed, n) always gives the same draws."""
        rnd = random.Random(f"uncertainty:{seed}")
        return [self._one(rnd) for _ in range(n)]

    def draw(self, seed: int, key: str) -> Draw:
        """The draw of one stop (``key``, e.g. its stop id) in world ``seed``, independent of the other stops
        and of the order they are drawn in."""
        return self._one(random.Random(f"uncertainty:{seed}:{key}"))
