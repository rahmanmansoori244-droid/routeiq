"""The one cost model of a dispatch plan (review F17; owner decision: the driver is paid for the
WHOLE truck day).

Money is OMR. Every money figure the engine compares or reports comes from ``truck_day_costs``:

* the post-solve score every candidate plan is compared on (``load_repack.score``, money part);
* each scenario's loads, truck days and totals (``dispatch_solver._build_scenario``);
* through the response: the web's stored load costs (``PlanLoad.operatingCost`` / ``costJson``),
  the plan summary, the options table, the Excel workbook and the dashboard.

Policy ``TRUCK_DAY_SPAN``
-------------------------
* Driver time is paid from the truck day's first departure - or its first frozen (locked,
  loading, dispatched, completed) departure - to its last return, including the depot turnaround
  between loads and any waiting. Loading the day's first load before the shift is not paid.
* Overtime is the paid time after that first departure + ``overtime_after_min``, priced at
  ``overtime_cost_per_hour`` ON TOP of the driver rate.
* The truck's fixed cost is paid once per truck day; trip, distance and fuel costs per load.

Allocation to loads (documented rule, additive across plan versions)
-------------------------------------------------------------------
* Each load owns the paid interval (previous return of the same truck, its own return]. The day's
  first load owns (its departure, its return]; the first NEW load after frozen loads owns (last
  frozen return, its return].
* driver cost = length of that interval x driver rate; overtime = the part of the interval after
  first departure + overtime_after, x overtime rate.
* The fixed cost goes to the truck day's load 1 (a truck that already has frozen loads paid it with
  its first frozen load). Trip, distance and fuel are the load's own.

Earlier loads' shares never change when later loads are added, so a re-plan's frozen loads keep the
costs they were planned with and frozen + new = the whole truck day, nothing counted twice. (The
exception: loads locked out of order - a later load locked while an earlier one stays planned, then
re-planned after it. The locked load's stored share still starts at the earlier load's old return.)
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

COST_SCALE = 100_000  # objective units per OMR (1 unit = 0.00001 OMR)
COST_POLICY = "TRUCK_DAY_SPAN"
COST_VERSION = 2


@dataclass(frozen=True)
class DayRates:
    """Rates that apply to every truck of the day (from DispatchConfig)."""

    driver_per_hour: float = 0.0
    overtime_per_hour: float = 0.0
    overtime_after_s: int | None = None  # None = overtime not priced
    fuel_price_per_litre: float = 0.0

    @classmethod
    def from_config(cls, cfg) -> "DayRates":
        return cls(
            driver_per_hour=float(cfg.driver_cost_per_hour),
            overtime_per_hour=float(cfg.overtime_cost_per_hour),
            overtime_after_s=cfg.overtime_after_min * 60 if cfg.overtime_after_min is not None else None,
            fuel_price_per_litre=float(cfg.fuel_price_per_litre),
        )


@dataclass(frozen=True)
class TruckRates:
    fixed: float = 0.0  # OMR per truck day
    trip: float = 0.0  # OMR per load
    per_km: float = 0.0  # OMR per km, fuel excluded when km_per_litre is set
    km_per_litre: float | None = None

    @classmethod
    def from_truck(cls, t) -> "TruckRates":
        return cls(fixed=float(t.fixed_cost), trip=float(t.trip_cost), per_km=float(t.cost_per_km), km_per_litre=t.km_per_litre)


@dataclass(frozen=True)
class LoadTiming:
    depart_s: int
    return_s: int
    km: float


@dataclass(frozen=True)
class LoadCost:
    fixed: float
    trip: float
    distance: float
    fuel: float
    fuel_litres: float | None
    paid_from_s: int  # start of the paid interval this load owns
    paid_to_s: int  # its return
    driver: float
    overtime_s: int
    overtime: float

    @property
    def paid_s(self) -> int:
        return self.paid_to_s - self.paid_from_s

    @property
    def total(self) -> float:
        return self.fixed + self.trip + self.distance + self.fuel + self.driver + self.overtime


@dataclass(frozen=True)
class TruckDayCost:
    loads: tuple[LoadCost, ...]
    day_start_s: int  # first departure of the truck day (first frozen departure when frozen)
    anchored: bool  # the truck has frozen loads before these

    @property
    def paid_from_s(self) -> int:
        return self.loads[0].paid_from_s

    @property
    def last_return_s(self) -> int:
        return self.loads[-1].paid_to_s

    def sum(self, field: str) -> float:
        return sum(getattr(l, field) for l in self.loads)

    @property
    def total(self) -> float:
        return sum(l.total for l in self.loads)


def truck_day_costs(truck: TruckRates, rates: DayRates, loads: Sequence[LoadTiming], *,
                    anchor_s: int | None = None, frozen_return_s: int | None = None) -> TruckDayCost:
    """Costs of one truck's NEW loads of the day (in time order), allocated per load (see the
    module docstring). ``anchor_s`` / ``frozen_return_s``: first departure / last return of the
    truck's frozen loads, when it has any (the fixed cost was then paid by its first frozen load)."""
    if not loads:
        raise ValueError("truck_day_costs needs at least one load")
    anchored = anchor_s is not None
    day_start = anchor_s if anchored else loads[0].depart_s
    ot_from = day_start + rates.overtime_after_s if rates.overtime_after_s is not None and rates.overtime_per_hour > 0 else None
    out: list[LoadCost] = []
    prev_return = frozen_return_s if anchored and frozen_return_s is not None else None
    for j, ld in enumerate(loads):
        start = ld.depart_s if prev_return is None else min(prev_return, ld.depart_s)
        end = max(ld.return_s, start)
        ot_s = max(0, end - max(start, ot_from)) if ot_from is not None else 0
        litres = ld.km / truck.km_per_litre if truck.km_per_litre else None
        out.append(LoadCost(
            fixed=truck.fixed if (j == 0 and not anchored) else 0.0,
            trip=truck.trip,
            distance=ld.km * truck.per_km,
            fuel=(litres or 0.0) * rates.fuel_price_per_litre,
            fuel_litres=litres,
            paid_from_s=start,
            paid_to_s=end,
            driver=(end - start) / 3600.0 * rates.driver_per_hour,
            overtime_s=ot_s,
            overtime=ot_s / 3600.0 * rates.overtime_per_hour,
        ))
        prev_return = end
    return TruckDayCost(loads=tuple(out), day_start_s=day_start, anchored=anchored)


def to_units(omr: float) -> int:
    return int(round(omr * COST_SCALE))
