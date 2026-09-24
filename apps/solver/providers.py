"""Road-distance providers for the dispatch optimizer.

Every provider exposes the same small surface:

    provider.name            -> "OSRM" | "HAVERSINE"
    provider.is_estimated    -> False for real road-network data, True for straight-line estimates
    provider.get_matrix(coords)          -> MatrixResult (metres + seconds, n x n ints)
    provider.get_route_geometry(coords)  -> list[[lng, lat]] polyline (road shape or straight segments)

Production plans must be built on road distance. OSRM is the preferred engine, but RouteIQ is
never hard-wired to the public demo server: the endpoint comes from configuration
(``OSRM_URL`` env var or the per-request ``osrm_url``) so NMWC can point it at a self-hosted
OSRM built from the Oman extract. When no endpoint is configured, or the configured one fails,
``resolve_matrix`` falls back to Haversine x multiplier and says so loudly (``is_estimated`` and
a warning string) so the UI can label every distance as "estimated".
"""
from __future__ import annotations

import logging
import math
import os
import time
from dataclasses import dataclass, field
from urllib.parse import quote

import httpx

log = logging.getLogger("routeiq.providers")

EARTH_RADIUS_KM = 6371.0088
HTTP_TIMEOUT_SECS = 30
HTTP_MAX_RETRIES = 2
HTTP_RETRY_BACKOFF_SECS = 1.0
# OSRM's default --max-table-size is 100; self-hosted instances can raise it. We tile the
# table call so both the demo server and a stock self-hosted server work.
OSRM_TABLE_TILE = 90


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


@dataclass
class MatrixResult:
    distance_m: list[list[int]]
    duration_s: list[list[int]]
    provider_name: str
    is_estimated: bool
    warnings: list[str] = field(default_factory=list)
    # Cells the road provider could not route (null in OSRM) and that were patched with an
    # estimate. Non-zero means the matrix is "mostly road".
    patched_cells: int = 0


class HaversineProvider:
    name = "HAVERSINE"
    is_estimated = True

    def __init__(self, multiplier: float = 1.3, avg_speed_kmh: float = 40.0) -> None:
        self.multiplier = max(1.0, float(multiplier))
        self.avg_speed_kmh = max(1.0, float(avg_speed_kmh))

    def leg(self, a: tuple[float, float], b: tuple[float, float]) -> tuple[int, int]:
        km = haversine_km(a[0], a[1], b[0], b[1]) * self.multiplier
        return int(round(km * 1000)), int(round(km / self.avg_speed_kmh * 3600))

    def get_matrix(self, coords: list[tuple[float, float]]) -> MatrixResult:
        n = len(coords)
        dist = [[0] * n for _ in range(n)]
        dur = [[0] * n for _ in range(n)]
        for i in range(n):
            for j in range(n):
                if i != j:
                    dist[i][j], dur[i][j] = self.leg(coords[i], coords[j])
        return MatrixResult(dist, dur, self.name, True)

    def get_route_geometry(self, coords: list[tuple[float, float]]) -> list[list[float]]:
        return [[lng, lat] for lat, lng in coords]


class OSRMProvider:
    """OSRM ``/table`` + ``/route`` client. ``base_url`` is required - there is no silent default."""

    name = "OSRM"
    is_estimated = False

    def __init__(self, base_url: str, profile: str = "driving", timeout_s: float = HTTP_TIMEOUT_SECS,
                 fallback: HaversineProvider | None = None, client: httpx.Client | None = None) -> None:
        if not base_url:
            raise ValueError("OSRMProvider needs a base_url")
        self.base_url = base_url.rstrip("/")
        self.profile = profile
        self.timeout_s = timeout_s
        self.fallback = fallback or HaversineProvider()
        self._client = client

    def _get(self, url: str) -> dict:
        last: Exception | None = None
        for attempt in range(HTTP_MAX_RETRIES):
            try:
                if self._client is not None:
                    r = self._client.get(url, headers={"User-Agent": "RouteIQ-Solver/2.0"})
                else:
                    with httpx.Client(timeout=self.timeout_s) as c:
                        r = c.get(url, headers={"User-Agent": "RouteIQ-Solver/2.0"})
                r.raise_for_status()
                body = r.json()
                if body.get("code") != "Ok":
                    raise ValueError(f"OSRM returned code={body.get('code')!r}")
                return body
            except Exception as exc:  # noqa: BLE001
                last = exc
                log.warning("OSRM request failed (attempt %d): %s", attempt + 1, exc)
                if attempt < HTTP_MAX_RETRIES - 1:
                    time.sleep(HTTP_RETRY_BACKOFF_SECS * (attempt + 1))
        raise RuntimeError(f"OSRM unavailable: {last}")

    def _table(self, coords: list[tuple[float, float]], src: list[int], dst: list[int]) -> tuple[list, list]:
        idx = sorted(set(src) | set(dst))
        pos = {orig: p for p, orig in enumerate(idx)}
        coord_str = ";".join(f"{coords[i][1]:.6f},{coords[i][0]:.6f}" for i in idx)
        url = (
            f"{self.base_url}/table/v1/{self.profile}/{quote(coord_str, safe=';,.')}"
            f"?annotations=distance,duration"
            f"&sources={';'.join(str(pos[i]) for i in src)}"
            f"&destinations={';'.join(str(pos[i]) for i in dst)}"
        )
        body = self._get(url)
        return body.get("distances") or [], body.get("durations") or []

    def get_matrix(self, coords: list[tuple[float, float]]) -> MatrixResult:
        n = len(coords)
        dist = [[0] * n for _ in range(n)]
        dur = [[0] * n for _ in range(n)]
        patched = 0
        half = max(1, OSRM_TABLE_TILE // 2)
        for s0 in range(0, n, half):
            src = list(range(s0, min(n, s0 + half)))
            for d0 in range(0, n, half):
                dst = list(range(d0, min(n, d0 + half)))
                distances, durations = self._table(coords, src, dst)
                if len(distances) != len(src) or len(durations) != len(src):
                    raise RuntimeError("OSRM returned a matrix of the wrong shape")
                for si, i in enumerate(src):
                    if len(distances[si]) != len(dst) or len(durations[si]) != len(dst):
                        raise RuntimeError("OSRM returned a row of the wrong length")
                    for di, j in enumerate(dst):
                        if i == j:
                            continue
                        d_m, t_s = distances[si][di], durations[si][di]
                        if d_m is None or t_s is None:
                            dist[i][j], dur[i][j] = self.fallback.leg(coords[i], coords[j])
                            patched += 1
                        else:
                            dist[i][j] = int(round(float(d_m)))
                            dur[i][j] = int(round(float(t_s)))
        warnings = []
        if patched:
            warnings.append(
                f"OSRM could not route {patched} of {n * (n - 1)} legs; those legs use estimated distance."
            )
        return MatrixResult(dist, dur, self.name, False, warnings, patched)

    def get_route_geometry(self, coords: list[tuple[float, float]]) -> list[list[float]]:
        coord_str = ";".join(f"{lng:.6f},{lat:.6f}" for lat, lng in coords)
        url = (
            f"{self.base_url}/route/v1/{self.profile}/{quote(coord_str, safe=';,.')}"
            f"?overview=full&geometries=geojson"
        )
        body = self._get(url)
        routes = body.get("routes") or []
        if not routes:
            raise RuntimeError("OSRM returned no route")
        return routes[0]["geometry"]["coordinates"]


def configured_osrm_url(request_url: str | None = None) -> str:
    """Request override first, then the OSRM_URL env var. Empty string = not configured."""
    return (request_url or os.environ.get("OSRM_URL") or "").strip()


def resolve_matrix(
    coords: list[tuple[float, float]],
    *,
    provider: str,
    osrm_url: str | None,
    haversine_multiplier: float,
    avg_speed_kmh: float,
    road_time_factor: float = 1.0,
    osrm_client: httpx.Client | None = None,
) -> MatrixResult:
    """Build the matrix with the requested provider, falling back to Haversine with a warning."""
    fallback = HaversineProvider(haversine_multiplier, avg_speed_kmh)
    if provider.upper() == "HAVERSINE":
        res = fallback.get_matrix(coords)
        res.warnings.append(
            "Distances are ESTIMATED (straight line x road factor). Configure OSRM for road distance."
        )
        return res
    url = configured_osrm_url(osrm_url)
    if not url:
        res = fallback.get_matrix(coords)
        res.warnings.append(
            "Road routing (OSRM) is not configured - distances are ESTIMATED (straight line x road factor)."
        )
        return res
    try:
        res = OSRMProvider(url, fallback=fallback, client=osrm_client).get_matrix(coords)
        if road_time_factor and road_time_factor != 1.0:
            res.duration_s = [[int(round(v * road_time_factor)) for v in row] for row in res.duration_s]
        return res
    except Exception as exc:  # noqa: BLE001
        log.warning("OSRM matrix failed, falling back to Haversine: %s", exc)
        res = fallback.get_matrix(coords)
        res.warnings.append(
            f"ROUTING_PROVIDER_FAILURE: road routing failed ({exc}); distances are ESTIMATED."
        )
        return res
