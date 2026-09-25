"""Road-distance providers for the dispatch optimizer.

Every provider exposes the same small surface:

    provider.name            -> "OSRM" | "HAVERSINE"
    provider.is_estimated    -> False for real road-network data, True for straight-line estimates
    provider.get_matrix(coords, deadline)  -> MatrixResult (metres + seconds, n x n ints)
    provider.get_route_geometry(coords)    -> list[[lng, lat]] polyline (road shape or straight segments)

Production plans must be built on road distance. OSRM is the preferred engine, but RouteIQ is
never hard-wired to the public demo server: the endpoint comes from configuration
(``OSRM_URL`` env var or the per-request ``osrm_url``) so NMWC can point it at a self-hosted
OSRM built from the Oman extract. When no endpoint is configured, or the configured one fails
or is too slow, ``resolve_matrix`` falls back to Haversine x multiplier and says so loudly
(``is_estimated`` and a warning string) so the UI can label every distance as "estimated".

Provenance (review F18): a road matrix can still hold estimated legs (a pair OSRM could not route,
a point far from any road). They are tracked per cell (``MatrixResult.estimated``), the truck
factor ``road_time_factor`` is applied to real road cells only, and ``quality`` says ROAD, MIXED or
ESTIMATED.
"""
from __future__ import annotations

import json
import logging
import math
import os
import time
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from urllib.parse import quote

import httpx

log = logging.getLogger("routeiq.providers")

EARTH_RADIUS_KM = 6371.0088
HTTP_TIMEOUT_SECS = 30  # read timeout per attempt (capped by the time left before a deadline)
HTTP_CONNECT_SECS = 2.0
HTTP_MAX_RETRIES = 2
HTTP_RETRY_BACKOFF_SECS = 1.0


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(os.environ.get(name, default))))
    except ValueError:
        return default


# Coordinates per OSRM /table call: each call asks for a block of (tile / 2) sources x (tile / 2)
# destinations, so a call never sends more than `tile` coordinates. OSRM's stock
# --max-table-size is 100 (hence the default 90); the RouteIQ image (infra/osrm) allows 1000, so
# production can set OSRM_TABLE_TILE=1000 and route a normal NMWC day in ONE call.
OSRM_TABLE_TILE = _env_int("OSRM_TABLE_TILE", 90, 2, 10_000)
# Table calls in flight at once when a matrix needs several (bounded; 1 = one after another).
OSRM_PARALLEL = _env_int("OSRM_PARALLEL", 2, 1, 4)
# OSRM snaps every point to its nearest road, however far. A point further than this from any
# road in the routing map (outside the map's area, or a wrong pin) is not routed on roads: its
# legs use the estimated distance instead of a meaningless "road" distance.
OSRM_MAX_SNAP_M = float(os.environ.get("OSRM_MAX_SNAP_M", "5000"))


class MatrixDeadline(RuntimeError):
    """Road routing did not answer before the matrix deadline (review F19)."""


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def matrix_quality(n: int, estimated_cells: int, all_estimated: bool = False) -> str:
    """ROAD: every leg is a road distance; ESTIMATED: every leg is an estimate; MIXED otherwise."""
    if all_estimated:
        return "ESTIMATED"
    if estimated_cells <= 0:
        return "ROAD"
    return "ESTIMATED" if estimated_cells >= n * (n - 1) else "MIXED"


@dataclass
class MatrixResult:
    distance_m: list[list[int]]
    duration_s: list[list[int]]
    provider_name: str
    # True only when EVERY leg is an estimate (quality ESTIMATED). Which legs are estimated:
    # leg_estimated(i, j).
    is_estimated: bool
    warnings: list[str] = field(default_factory=list)
    # Cells the road provider could not route (null in OSRM, or a point far from any road) and
    # that were patched with an estimate. Non-zero means the matrix is "mostly road".
    patched_cells: int = 0
    # The patched cells themselves (i, j) - OSRM matrices only.
    estimated: set[tuple[int, int]] = field(default_factory=set)
    # Every cell is an estimate (a Haversine matrix, or the fallback when routing failed).
    all_estimated: bool = False
    quality: str = "ROAD"
    seconds: float = 0.0  # time spent building the matrix

    def leg_estimated(self, i: int, j: int) -> bool:
        if i == j:
            return False
        return self.all_estimated or (i, j) in self.estimated


class HaversineProvider:
    name = "HAVERSINE"
    is_estimated = True

    def __init__(self, multiplier: float = 1.3, avg_speed_kmh: float = 40.0) -> None:
        self.multiplier = max(1.0, float(multiplier))
        self.avg_speed_kmh = max(1.0, float(avg_speed_kmh))

    def leg(self, a: tuple[float, float], b: tuple[float, float]) -> tuple[int, int]:
        km = haversine_km(a[0], a[1], b[0], b[1]) * self.multiplier
        return int(round(km * 1000)), int(round(km / self.avg_speed_kmh * 3600))

    def get_matrix(self, coords: list[tuple[float, float]], deadline: float | None = None) -> MatrixResult:
        n = len(coords)
        dist = [[0] * n for _ in range(n)]
        dur = [[0] * n for _ in range(n)]
        for i in range(n):
            for j in range(n):
                if i != j:
                    dist[i][j], dur[i][j] = self.leg(coords[i], coords[j])
        return MatrixResult(dist, dur, self.name, True, all_estimated=True, quality="ESTIMATED")

    def get_route_geometry(self, coords: list[tuple[float, float]]) -> list[list[float]]:
        return [[lng, lat] for lat, lng in coords]


class OSRMProvider:
    """OSRM ``/table`` + ``/route`` client. ``base_url`` is required - there is no silent default.

    Timeouts (review F19): every attempt gets connect 2 s and read min(30 s, time left before the
    deadline); a retry is skipped when less than the backoff + 2 s is left; a response still
    arriving at the deadline is cut, and a request that has not answered is abandoned. One HTTP
    client per matrix (connections reused); tiles are fetched OSRM_PARALLEL at a time."""

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

    def _timeout(self, deadline: float | None) -> httpx.Timeout:
        read = float(self.timeout_s)
        if deadline is not None:
            read = max(0.05, min(read, deadline - time.monotonic()))
        return httpx.Timeout(connect=min(HTTP_CONNECT_SECS, read), read=read, write=min(5.0, read), pool=min(2.0, read))

    def _fetch(self, client: httpx.Client, url: str, deadline: float | None) -> dict:
        with client.stream("GET", url, headers={"User-Agent": "RouteIQ-Solver/2.0"}, timeout=self._timeout(deadline)) as r:
            r.raise_for_status()
            chunks = []
            for chunk in r.iter_bytes():
                chunks.append(chunk)
                if deadline is not None and time.monotonic() > deadline:
                    raise MatrixDeadline("road routing answer still arriving at the deadline")
        return json.loads(b"".join(chunks))

    def _get(self, url: str, client: httpx.Client | None = None, deadline: float | None = None) -> dict:
        last: Exception | None = None
        c = client or self._client
        own = c is None
        if c is None:
            c = httpx.Client()
        try:
            for attempt in range(HTTP_MAX_RETRIES):
                if deadline is not None and time.monotonic() >= deadline:
                    raise MatrixDeadline("no time left for road routing")
                try:
                    body = self._fetch(c, url, deadline)
                    if body.get("code") != "Ok":
                        raise ValueError(f"OSRM returned code={body.get('code')!r}")
                    return body
                except MatrixDeadline:
                    raise
                except Exception as exc:  # noqa: BLE001
                    last = exc
                    log.warning("OSRM request failed (attempt %d): %s", attempt + 1, exc)
                    if attempt < HTTP_MAX_RETRIES - 1:
                        backoff = HTTP_RETRY_BACKOFF_SECS * (attempt + 1)
                        if deadline is not None and deadline - time.monotonic() < backoff + 2:
                            break  # no time left for a useful retry
                        time.sleep(backoff)
            if deadline is not None and time.monotonic() >= deadline:
                raise MatrixDeadline(f"road routing timed out ({last})")
            raise RuntimeError(f"OSRM unavailable: {last}")
        finally:
            if own:
                c.close()

    def _table(self, coords: list[tuple[float, float]], src: list[int], dst: list[int],
               client: httpx.Client | None = None, deadline: float | None = None) -> tuple[list, list, dict[int, float]]:
        idx = sorted(set(src) | set(dst))
        pos = {orig: p for p, orig in enumerate(idx)}
        coord_str = ";".join(f"{coords[i][1]:.6f},{coords[i][0]:.6f}" for i in idx)
        url = (
            f"{self.base_url}/table/v1/{self.profile}/{quote(coord_str, safe=';,.')}"
            f"?annotations=distance,duration"
            f"&sources={';'.join(str(pos[i]) for i in src)}"
            f"&destinations={';'.join(str(pos[i]) for i in dst)}"
        )
        body = self._get(url, client, deadline)
        # Snap distance (metres from the input point to the road it was moved onto) per coordinate.
        snaps: dict[int, float] = {}
        for key, order in (("sources", src), ("destinations", dst)):
            for k, w in enumerate(body.get(key) or []):
                d = w.get("distance") if isinstance(w, dict) else None
                if k < len(order) and isinstance(d, (int, float)):
                    snaps[order[k]] = max(snaps.get(order[k], 0.0), float(d))
        return body.get("distances") or [], body.get("durations") or [], snaps

    def get_matrix(self, coords: list[tuple[float, float]], deadline: float | None = None) -> MatrixResult:
        """Road matrix in OSRM_TABLE_TILE blocks. Raises MatrixDeadline when routing has not
        finished at ``deadline`` (time.monotonic()), RuntimeError when OSRM fails."""
        n = len(coords)
        dist = [[0] * n for _ in range(n)]
        dur = [[0] * n for _ in range(n)]
        patched_set: set[tuple[int, int]] = set()
        snap: dict[int, float] = {}
        half = max(1, _env_int("OSRM_TABLE_TILE", OSRM_TABLE_TILE, 2, 10_000) // 2)
        blocks = [list(range(a, min(n, a + half))) for a in range(0, n, half)]
        tiles = [(src, dst) for src in blocks for dst in blocks]
        client = self._client if self._client is not None else httpx.Client()
        workers = _env_int("OSRM_PARALLEL", OSRM_PARALLEL, 1, 4)
        pool = ThreadPoolExecutor(max_workers=max(1, min(workers, len(tiles))), thread_name_prefix="osrm")
        try:
            futs = {pool.submit(self._table, coords, src, dst, client, deadline): (src, dst) for src, dst in tiles}
            timeout = None if deadline is None else max(0.0, deadline - time.monotonic())
            done, pending = wait(futs, timeout=timeout, return_when=FIRST_EXCEPTION)
            for f in done:
                exc = f.exception()
                if exc is not None:
                    raise exc
            if pending:
                raise MatrixDeadline(f"{len(pending)} of {len(tiles)} road-routing requests unanswered at the deadline")
            for f, (src, dst) in futs.items():
                distances, durations, snaps = f.result()
                for i, d in snaps.items():
                    snap[i] = max(snap.get(i, 0.0), d)
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
                            patched_set.add((i, j))
                        else:
                            dist[i][j] = int(round(float(d_m)))
                            dur[i][j] = int(round(float(t_s)))
        finally:
            # A request still hanging at the deadline is abandoned, never waited for.
            pool.shutdown(wait=False, cancel_futures=True)
            if client is not self._client:
                client.close()
        warnings = []
        if patched_set:
            warnings.append(
                f"OSRM could not route {len(patched_set)} of {n * (n - 1)} legs; those legs use estimated distance."
            )
        far = sorted(i for i, d in snap.items() if d > OSRM_MAX_SNAP_M)
        if far:
            cells = {(i, j) for i in far for j in range(n) if j != i} | {(j, i) for i in far for j in range(n) if j != i}
            for i, j in cells:
                dist[i][j], dur[i][j] = self.fallback.leg(coords[i], coords[j])
            patched_set |= cells
            warnings.append(
                f"{len(far)} point(s) are more than {OSRM_MAX_SNAP_M / 1000:g} km from any road in the routing map "
                "(outside its area, or a wrong location pin); their legs use estimated distance."
            )
        quality = matrix_quality(n, len(patched_set))
        return MatrixResult(dist, dur, self.name, quality == "ESTIMATED", warnings, len(patched_set),
                            estimated=patched_set, quality=quality)

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
    deadline: float | None = None,
) -> MatrixResult:
    """Build the matrix with the requested provider, falling back to Haversine with a warning.

    ``deadline`` (time.monotonic()): road routing that has not answered by then is abandoned and
    the whole matrix is estimated, with a warning - a slow routing server never eats the solver's
    time budget. ``road_time_factor`` scales real road durations only, never an estimated leg
    (estimates already use the truck's average speed)."""
    t0 = time.monotonic()
    fallback = HaversineProvider(haversine_multiplier, avg_speed_kmh)
    if provider.upper() == "HAVERSINE":
        res = fallback.get_matrix(coords)
        res.warnings.append(
            "Distances are ESTIMATED (straight line x road factor). Configure OSRM for road distance."
        )
        res.seconds = time.monotonic() - t0
        return res
    url = configured_osrm_url(osrm_url)
    if not url:
        res = fallback.get_matrix(coords)
        res.warnings.append(
            "Road routing (OSRM) is not configured - distances are ESTIMATED (straight line x road factor)."
        )
        res.seconds = time.monotonic() - t0
        return res
    try:
        res = OSRMProvider(url, fallback=fallback, client=osrm_client).get_matrix(coords, deadline=deadline)
        if road_time_factor and road_time_factor != 1.0:
            est = res.estimated
            res.duration_s = [
                [v if (i, j) in est else int(round(v * road_time_factor)) for j, v in enumerate(row)]
                for i, row in enumerate(res.duration_s)
            ]
    except MatrixDeadline as exc:
        waited = time.monotonic() - t0
        log.warning("OSRM matrix too slow (%.1fs, %s); falling back to Haversine", waited, exc)
        res = fallback.get_matrix(coords)
        res.warnings.append(
            f"ROUTING_PROVIDER_FAILURE: road routing too slow (no full answer after {waited:.0f} s); "
            "distances are ESTIMATED (straight line x road factor)."
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("OSRM matrix failed, falling back to Haversine: %s", exc)
        res = fallback.get_matrix(coords)
        res.warnings.append(
            f"ROUTING_PROVIDER_FAILURE: road routing failed ({exc}); distances are ESTIMATED."
        )
    res.seconds = time.monotonic() - t0
    return res
