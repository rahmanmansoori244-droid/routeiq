"""Labelled synthetic NMWC-like delivery days (DESIGN.md section 1.2). SYNTHETIC: no real customer.

``make_day(n_invoices, seed)`` builds a DispatchRequest the way the web builds one: several invoices of a
customer are merged into one stop (cases and pallets added up, one service time), and the service time is
the web's formula base + 0.25 min x cases. Customers sit around public Muscat district centres (the same
centres as the web's synthetic data, apps/web/prisma/nmwc-dispatch-data.ts), plus small remote orders in
Quriyat, Samail and Bidbid. Every invented number is in ``SynthDay.assumptions``.

Window provenance is a generated label (RouteIQ has no such field): CUSTOMER_HARD (a genuine receiving
time), SALES_PREFERENCE (a salesman or merchandiser asked for it) or UNKNOWN. Only SALES_PREFERENCE may be
flexed by a what-if; UNKNOWN only in a variant labelled HYPOTHETICAL.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from dispatch_models import DispatchConfig, DispatchDepot, DispatchRequest, DispatchStop, DispatchTruck

CUSTOMER_HARD, SALES_PREFERENCE, UNKNOWN = "CUSTOMER_HARD", "SALES_PREFERENCE", "UNKNOWN"

# The web's synthetic depot ("Ghala Industrial Area", nmwc-dispatch-data.ts NMWC_DEPOT), open 05:00-23:00.
DEPOT = {"lat": 23.568, "lng": 58.392, "open_min": 300, "close_min": 1380}

# Public district centres (lat, lng, jitter radius km, landward-only jitter): nmwc-dispatch-data.ts NMWC_AREAS.
AREAS: dict[str, tuple[float, float, float, str | None]] = {
    "Al Khuwair": (23.588, 58.408, 1.0, None), "Ruwi": (23.598, 58.543, 1.1, None),
    "Seeb": (23.67, 58.189, 0.9, "S"), "Mabellah": (23.642, 58.11, 1.1, None),
    "Bawshar": (23.57, 58.395, 1.1, None), "Al Amerat": (23.519, 58.497, 1.1, None),
    "Qurum": (23.614, 58.475, 0.6, "S"), "Ghubrah": (23.6, 58.371, 0.6, "S"),
    "Al Hail": (23.648, 58.253, 0.9, "S"), "Mawaleh": (23.617, 58.237, 1.1, None),
    "Azaiba": (23.598, 58.34, 0.6, "S"), "Muttrah": (23.617, 58.566, 0.5, "S"),
    "Wadi Kabir": (23.585, 58.56, 1.0, None), "Al Ansab": (23.555, 58.335, 1.0, None),
}
# Remote towns of the small orders (public town centres; Quriyat from NMWC_AREAS, Samail and Bidbid added).
REMOTE_AREAS: dict[str, tuple[float, float, float, str | None]] = {
    "Quriyat": (23.263, 58.916, 0.5, "SW"), "Samail": (23.302, 57.978, 0.5, None), "Bidbid": (23.408, 58.128, 0.5, None),
}
OLD_TOWN = ("Ruwi", "Muttrah", "Wadi Kabir")  # narrow streets: some groceries take small trucks only


@dataclass(frozen=True)
class CustomerType:
    """How one kind of customer is generated. Windows are (start, end) minutes of the day; provenance
    weights apply to the hard window; genuine = the customer's real opening hours (None: not known)."""

    share: float  # of the non-remote customers
    invoices: tuple[int, int]
    cases: tuple[int, int]  # per invoice, at least 4: only the invoices picked as small have 1-3 cases
    base_min: float  # service time base (minutes), + SERVICE_PER_CASE x cases
    priorities: tuple[int, ...]
    windows: tuple[tuple[int, int], ...]
    pref: tuple[int, int] | None
    provenance: dict[str, float]
    accepts_afternoon: float
    accepts_night: float
    genuine: tuple[int, int] | None
    small_ok: bool  # may have 1-3 case invoices
    cases_per_pallet: tuple[int, ...]


# GROCERY has two window profiles: most are open all day (genuine hours), MORNING_GROCERY_SHARE carry a
# morning window a salesman asked for (or of unknown origin).
TYPES: dict[str, CustomerType] = {
    "HYPERMARKET": CustomerType(0.08, (2, 4), (40, 160), 17, (1, 2), ((420, 660), (480, 720)), None,
                                {CUSTOMER_HARD: 0.55, SALES_PREFERENCE: 0.30, UNKNOWN: 0.15}, 0.2, 0.4, (360, 1320),
                                False, (80, 100, 110)),
    "SUPERMARKET": CustomerType(0.15, (1, 3), (15, 80), 20, (2, 3), ((420, 780), (480, 840)), (480, 660),
                                {CUSTOMER_HARD: 0.40, SALES_PREFERENCE: 0.35, UNKNOWN: 0.25}, 0.6, 0.15, (420, 1320),
                                True, (80, 100, 110)),
    "GROCERY": CustomerType(0.47, (1, 2), (5, 40), 11, (3, 4, 5), ((420, 1260),), (540, 780),
                            {CUSTOMER_HARD: 1.0}, 0.85, 0.1, (420, 1260), True, (48, 80, 100, 110)),
    "HORECA": CustomerType(0.15, (1, 2), (4, 30), 8, (2, 3), ((480, 660),), None,
                           {CUSTOMER_HARD: 0.60, UNKNOWN: 0.40}, 0.3, 0.05, None, True, (40, 48, 100)),
    "DARK_STORE": CustomerType(0.05, (1, 2), (20, 60), 27, (2, 3), ((420, 1380),), (480, 720),
                               {CUSTOMER_HARD: 1.0}, 1.0, 0.7, (420, 1380), False, (80, 100, 110)),
}
MORNING_GROCERY_SHARE = 0.30
MORNING_GROCERY = {"window": (480, 720), "provenance": {SALES_PREFERENCE: 0.6, UNKNOWN: 0.4}}
REMOTE = {"invoice_share": 0.025, "window": (420, 780), "provenance": {SALES_PREFERENCE: 0.5, UNKNOWN: 0.5},
          "priorities": (3, 4, 5), "accepts_afternoon": 0.7, "accepts_night": 0.0, "genuine": (420, 1260)}
SMALL_INVOICE_SHARE = 0.25  # invoices of 1-3 cases
SMALL_CASES = (1, 3)
SMALL_TRUCK_ONLY_SHARE = 0.25  # of old-town groceries
SMALL_TRUCK_MAX_BAYS = 6
SERVICE_PER_CASE = 0.25  # minutes per case (the 14 Oct benchmark)
SERVICE_CAP_MIN = 480  # the web's cap (service-time.ts)
CASES_PER_BAY = 95  # about the company's 12 bays = 1,140 cases
# The fleet of a 320-invoice day; smaller or larger days take evenly spread trucks of it / repeat it.
FLEET_BAYS = (4, 4, 5, 5, 6, 6, 6, 11, 11, 12, 12, 12, 14)
INVOICES_PER_TRUCK = 320 / len(FLEET_BAYS)
TRUCK_COSTS = {  # bays -> fixed OMR/day, OMR/km excluding fuel, km per litre, max trips
    "small (4-6 bays)": (8.0, 0.04, 4.0, 3),
    "large (11-12 bays)": (24.0, 0.07, 3.5, 2),
    "14 bays": (30.0, 0.08, 3.0, 2),
}
CONFIG = dict(
    shift_start_min=450, shift_max_min=690, latest_return_min=1140, overtime_after_min=600,
    overtime_cost_per_hour=4.0, reload_min=30, loading_min_per_case=0.0, window_rule="START",
    break_min=60, break_start_from_min=840, break_start_to_min=900, max_trips_per_truck=3,
    pallet_fill_pct=90, single_customer_fill_pct=100, fuel_price_per_litre=0.26, driver_cost_per_hour=2.5,
    strict_priorities=True, use_margin=True, distance_provider="HAVERSINE", scenarios=["RECOMMENDED"],
)


def service_min(base_min: float, cases: int) -> int:
    """The web's stop time (service-time.ts): base + per case x cases, rounded half up (Math.round), capped."""
    return min(SERVICE_CAP_MIN, math.floor(base_min + SERVICE_PER_CASE * cases + 0.5))


def _truck_costs(bays: int) -> tuple[float, float, float, int]:
    if bays <= SMALL_TRUCK_MAX_BAYS:
        return TRUCK_COSTS["small (4-6 bays)"]
    return TRUCK_COSTS["14 bays"] if bays >= 14 else TRUCK_COSTS["large (11-12 bays)"]


@dataclass
class SynthDay:
    """A generated day and its labels. Every per-customer map is keyed by stop_id (one stop per customer)."""

    request: DispatchRequest
    seed: int
    profile: str
    window_provenance: dict[str, str]
    accepts_afternoon: dict[str, bool]
    accepts_night: dict[str, bool]
    genuine_hours: dict[str, tuple[int, int]]  # real opening hours of SALES_PREFERENCE stops (what-ifs widen to them)
    customer_type: dict[str, str]
    area: dict[str, str]
    invoice_stop: dict[str, str]  # invoice id -> stop id (DispatchStop.order_ids holds the invoices)
    invoice_cases: dict[str, int]
    assumptions: dict[str, dict] = field(default_factory=dict)
    label: str = "SYNTHETIC"

    @property
    def small_invoices(self) -> list[str]:
        """Invoices of 1-3 cases."""
        return [i for i, c in self.invoice_cases.items() if c <= SMALL_CASES[1]]

    @property
    def small_stops(self) -> list[str]:
        """Stops of 3 cases or fewer in total (the economics' small stops)."""
        return [s.stop_id for s in self.request.stops if s.demand_cases <= SMALL_CASES[1]]

    @property
    def remote_stops(self) -> list[str]:
        """Stops in the remote towns (REMOTE_AREAS)."""
        return [sid for sid, a in self.area.items() if a in REMOTE_AREAS]


def _point(rnd: random.Random, centre: tuple[float, float, float, str | None]) -> tuple[float, float]:
    """A point within the centre's radius (uniform over the disc; landward half for coastal centres)."""
    lat0, lng0, max_km, inland = centre
    r = math.sqrt(rnd.random()) * max_km
    theta = rnd.random() * 2 * math.pi
    d_lat, d_lng = r * math.sin(theta), r * math.cos(theta)
    if inland:
        d_lat = -abs(d_lat)
    if inland == "SW":
        d_lng = -abs(d_lng)
    return round(lat0 + d_lat / 110.574, 5), round(lng0 + d_lng / (111.32 * math.cos(math.radians(lat0))), 5)


def _pick(rnd: random.Random, weights: dict[str, float]) -> str:
    keys = sorted(weights)
    return rnd.choices(keys, weights=[weights[k] for k in keys])[0]


def _fleet_bays(n_invoices: int) -> list[int]:
    n = max(3, round(n_invoices / INVOICES_PER_TRUCK))
    if n >= len(FLEET_BAYS):
        return [FLEET_BAYS[i % len(FLEET_BAYS)] for i in range(n)]
    last = len(FLEET_BAYS) - 1
    return [FLEET_BAYS[round(i * last / (n - 1))] for i in range(n)]


def _assumptions(margin_per_case: float | None) -> dict[str, dict]:
    """Every invented number of the generator, with its basis."""
    a = {
        "label": {"value": "SYNTHETIC", "basis": "generated; no real customer, location or order"},
        "depot": {"value": DEPOT, "basis": "the web's synthetic depot (nmwc-dispatch-data.ts NMWC_DEPOT)"},
        "areas": {"value": {k: v[:3] for k, v in AREAS.items()},
                  "basis": "public district centres and jitter radii of nmwc-dispatch-data.ts NMWC_AREAS"},
        "remote_areas": {"value": {k: v[:3] for k, v in REMOTE_AREAS.items()},
                         "basis": "public town centres (Quriyat from NMWC_AREAS; Samail, Bidbid approximate)"},
        "customer_types": {"value": {k: {f: getattr(t, f) for f in t.__dataclass_fields__} for k, t in TYPES.items()},
                           "basis": "invented NMWC-like mix; service bases rounded from the 13 Oct truck-evidence "
                                    "drop-size model (Fleet parameters), windows from the web's type profiles"},
        "morning_grocery": {"value": {"share": MORNING_GROCERY_SHARE, **MORNING_GROCERY},
                            "basis": "invented: groceries whose morning window came from a salesman"},
        "remote": {"value": REMOTE, "basis": "invented: about 2.5% of invoices, 1-3 cases each"},
        "small_invoice_share": {"value": SMALL_INVOICE_SHARE, "basis": "owner: about 25% of invoices are 1-3 cases"},
        "small_cases": {"value": SMALL_CASES, "basis": "owner's definition of a small order"},
        "small_truck_only_share": {"value": SMALL_TRUCK_ONLY_SHARE,
                                   "basis": f"invented: share of old-town groceries ({', '.join(OLD_TOWN)}) "
                                            f"that take trucks of at most {SMALL_TRUCK_MAX_BAYS} bays"},
        "service_per_case_min": {"value": SERVICE_PER_CASE, "basis": "14 Oct benchmark (TenantConfig.serviceMinPerCase)"},
        "service_cap_min": {"value": SERVICE_CAP_MIN, "basis": "the web's cap (service-time.ts)"},
        "cases_per_bay": {"value": CASES_PER_BAY, "basis": "about the company's truck sizes (12 bays = 1,140 cases)"},
        "invoice_lines": {"value": 1, "basis": "invented: one product line per invoice, its cases per pallet drawn from "
                                               "the type's list; pallets rounded up per line, as the web does"},
        "weights": {"value": None, "basis": "no kg on stops or trucks: NMWC plans by bays (payload not limited)"},
        "fleet_bays": {"value": FLEET_BAYS, "basis": f"invented mixed fleet for 320 invoices; one truck per "
                                                     f"{INVOICES_PER_TRUCK:.1f} invoices, at least 3"},
        "truck_costs": {"value": TRUCK_COSTS, "basis": "invented, same order of magnitude as the company's settings"},
        "config": {"value": CONFIG, "basis": "invented; shift, return and break like the 15 Oct requests, reload 30 "
                                             "min from the truck evidence, fuel 0.26 OMR/l the web's ASSUMPTION"},
        "margin_per_case": {"value": margin_per_case,
                            "basis": "explicit caller assumption" if margin_per_case is not None
                            else "none: no margin is generated (economics reports a break-even margin)"},
    }
    return a


def make_day(n_invoices: int = 320, seed: int = 1, *, profile: str = "nmwc",
             margin_per_case: float | None = None) -> SynthDay:
    """A synthetic day of ``n_invoices`` invoices, deterministic for ``seed``. Margins only when
    ``margin_per_case`` (OMR per case, a labelled assumption) is given."""
    if profile != "nmwc":
        raise ValueError(f"unknown profile {profile!r} (only 'nmwc')")
    if n_invoices < 4:
        raise ValueError("n_invoices must be at least 4")
    rnd = random.Random(seed)
    area_names = sorted(AREAS)
    type_names = sorted(TYPES)

    # Customers with their invoice counts: the remote ones first, then the mix until n_invoices.
    customers: list[dict] = []
    n_remote = max(1, round(REMOTE["invoice_share"] * n_invoices))
    remote_names = sorted(REMOTE_AREAS)
    for i in range(n_remote):
        customers.append({"type": "GROCERY", "remote": True, "area": remote_names[i % len(remote_names)], "n": 1})
    total = n_remote
    while total < n_invoices:
        kind = rnd.choices(type_names, weights=[TYPES[k].share for k in type_names])[0]
        n = min(rnd.randint(*TYPES[kind].invoices), n_invoices - total)
        customers.append({"type": kind, "remote": False, "area": rnd.choice(area_names), "n": n})
        total += n

    # Invoices; then exactly SMALL_INVOICE_SHARE of them get 1-3 cases (every remote one, then others).
    invoices: list[dict] = []
    for ci, c in enumerate(customers):
        t = TYPES[c["type"]]
        for _ in range(c["n"]):
            invoices.append({"customer": ci, "cases": rnd.randint(*t.cases), "cpp": rnd.choice(t.cases_per_pallet),
                             "small_ok": c["remote"] or t.small_ok, "remote": c["remote"]})
    target_small = round(SMALL_INVOICE_SHARE * n_invoices)
    small = [k for k, inv in enumerate(invoices) if inv["remote"]]
    others = [k for k, inv in enumerate(invoices) if inv["small_ok"] and not inv["remote"]]
    small += rnd.sample(others, min(len(others), max(0, target_small - len(small))))
    for k in small:
        invoices[k]["cases"] = rnd.randint(*SMALL_CASES)

    # Fleet.
    trucks: list[DispatchTruck] = []
    for i, bays in enumerate(_fleet_bays(n_invoices), start=1):
        fixed, per_km, km_l, trips = _truck_costs(bays)
        trucks.append(DispatchTruck(id=f"T{i:02d}", code=f"SYN-{bays}B-{i:02d}", capacity_cases=bays * CASES_PER_BAY,
                                    bays=bays, fixed_cost=fixed, cost_per_km=per_km, km_per_litre=km_l, max_trips=trips))
    small_trucks = [t.id for t in trucks if (t.bays or 0) <= SMALL_TRUCK_MAX_BAYS]

    # One stop per customer, its invoices merged (cases and pallets added up, one service time).
    stops: list[DispatchStop] = []
    labels: dict[str, dict] = {k: {} for k in ("window_provenance", "accepts_afternoon", "accepts_night",
                                               "genuine_hours", "customer_type", "area", "invoice_stop", "invoice_cases")}
    inv_no = 0
    for ci, c in enumerate(customers):
        t = TYPES[c["type"]]
        sid, cid = f"syn-{ci + 1:03d}", f"cust-{ci + 1:03d}"
        mine = [inv for inv in invoices if inv["customer"] == ci]
        order_ids = []
        for inv in mine:
            inv_no += 1
            oid = f"inv-{inv_no:04d}"
            order_ids.append(oid)
            labels["invoice_stop"][oid], labels["invoice_cases"][oid] = sid, inv["cases"]
        cases = sum(inv["cases"] for inv in mine)
        units = sum(math.ceil(inv["cases"] * 1000 / inv["cpp"]) for inv in mine)
        centre = REMOTE_AREAS[c["area"]] if c["remote"] else AREAS[c["area"]]
        lat, lng = _point(rnd, centre)
        if c["remote"]:
            window, provenance, pref = REMOTE["window"], _pick(rnd, REMOTE["provenance"]), None
            priority = rnd.choice(REMOTE["priorities"])
            afternoon, night = rnd.random() < REMOTE["accepts_afternoon"], rnd.random() < REMOTE["accepts_night"]
            genuine = REMOTE["genuine"]
        else:
            window, pref = rnd.choice(t.windows), t.pref
            provenance = _pick(rnd, t.provenance)
            if c["type"] == "GROCERY" and rnd.random() < MORNING_GROCERY_SHARE:
                window, provenance, pref = MORNING_GROCERY["window"], _pick(rnd, MORNING_GROCERY["provenance"]), None
            priority = rnd.choice(t.priorities)
            afternoon, night = rnd.random() < t.accepts_afternoon, rnd.random() < t.accepts_night
            genuine = t.genuine
        allowed = None
        if c["type"] == "GROCERY" and c["area"] in OLD_TOWN and small_trucks and rnd.random() < SMALL_TRUCK_ONLY_SHARE:
            allowed = list(small_trucks)
        stops.append(DispatchStop(
            stop_id=sid, order_ids=order_ids, customer_id=cid, lat=lat, lng=lng, demand_cases=cases,
            demand_pallet_units=units, service_min=service_min(t.base_min, cases),
            priority=priority, hard_start_min=window[0], hard_end_min=window[1],
            pref_start_min=pref[0] if pref else None, pref_end_min=pref[1] if pref else None,
            margin=round(cases * margin_per_case, 3) if margin_per_case is not None else None,
            allowed_truck_ids=allowed,
            allowed_trucks_label=f"a small truck (at most {SMALL_TRUCK_MAX_BAYS} bays)" if allowed else None,
        ))
        labels["window_provenance"][sid] = provenance
        labels["accepts_afternoon"][sid], labels["accepts_night"][sid] = afternoon, night
        if genuine is not None and provenance == SALES_PREFERENCE:
            labels["genuine_hours"][sid] = genuine
        labels["customer_type"][sid], labels["area"][sid] = c["type"], c["area"]
    request = DispatchRequest(
        run_id=f"synthetic-{profile}-{n_invoices}-s{seed}", tenant_id="synthetic",
        depot=DispatchDepot(id="depot-syn", **DEPOT), trucks=trucks, stops=stops, config=DispatchConfig(**CONFIG),
    )
    return SynthDay(request=request, seed=seed, profile=profile, assumptions=_assumptions(margin_per_case), **labels)
