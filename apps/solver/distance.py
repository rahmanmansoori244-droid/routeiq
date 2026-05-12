"""Distance / duration matrix providers.

Two implementations:

  * ``haversine_matrix`` — straight-line × tenant multiplier. Zero cost, no
    network call. Returns the "Estimated km" the v1 spec talks about.
  * ``mapbox_matrix`` — Mapbox Directions Matrix API for real road distance
    and live-traffic duration. Returns ACTUAL km/duration along the road
    network. Used when the tenant flips
    ``TenantConfig.distanceProvider = MAPBOX_MATRIX``.

The solver picks one based on ``req.config.distance_provider``.

Mapbox limits (mapbox/driving): a single call accepts up to 25 coordinates
total (sources + destinations combined). For an n-node problem we tile into
``ceil(n/MAX_PER_CALL)`` × ``ceil(n/MAX_PER_CALL)`` calls, executed in
parallel via a thread pool. Each call returns a sub-matrix that we slot back
into the full n×n result.

Outputs use the same units as the OR-Tools v1 helpers so the rest of the
solver doesn't care which provider produced the matrices:
  * distance: centimeters (km × 100_000), integer
  * duration: seconds, integer
"""
from __future__ import annotations

import logging
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote

import httpx


log = logging.getLogger("routeiq.distance")

EARTH_RADIUS_KM = 6371.0088
MAPBOX_BASE = "https://api.mapbox.com/directions-matrix/v1/mapbox"
# Mapbox driving profile: source+destination total ≤ 25 in one call.
# Conservative tile = 12 sources × 12 destinations = 24 coords/call.
MAX_PER_CALL = 12
# Network + retry envelope.
HTTP_TIMEOUT_SECS = 30
HTTP_MAX_RETRIES = 3
HTTP_RETRY_BACKOFF_SECS = 1.5

# OSRM provides real road distance/duration for free. Defaults to the public
# demo (rate-limited but fine for v1 + small tenants). For production load,
# point OSRM_URL at a self-hosted instance (e.g. a $10/mo Hetzner VM running
# `osrm-routed --algo mld` on the Oman+UAE Geofabrik extract).
#
# When OSRM_URL is non-empty AND the configured provider is HAVERSINE, we
# transparently upgrade the matrix to OSRM at solve time. This is what
# eliminates the "zig-zag" routes a planner sees when straight-line distance
# fools PyVRP into thinking two stops on opposite sides of a wadi/highway
# are "close".
OSRM_URL = os.environ.get("OSRM_URL", "https://router.project-osrm.org").rstrip("/")
OSRM_MAX_COORDS_PER_CALL = 100  # OSRM has no hard limit; this keeps URLs sane.

# In-process LRU cache keyed by (provider, tenant_id, hash of coords + speed).
# Avoids re-hitting Mapbox for retried optimization attempts on the same run.
_MATRIX_CACHE: dict[str, tuple[list[list[int]], list[list[int]]]] = {}
_MATRIX_CACHE_MAX = 32


def _coords_cache_key(provider: str, tenant_id: str, coords: list[tuple[float, float]], suffix: str) -> str:
    coord_repr = ";".join(f"{lat:.6f},{lng:.6f}" for lat, lng in coords)
    return f"{provider}|{tenant_id}|{hash(coord_repr)}|{suffix}"


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# Haversine provider
# ---------------------------------------------------------------------------


def haversine_matrix(
    coords: list[tuple[float, float]],
    multiplier: float,
    avg_speed_kmh: float,
) -> tuple[list[list[int]], list[list[int]]]:
    """Returns (distance_cm, travel_time_secs) — same shape as v1 helpers."""
    n = len(coords)
    dist_cm = [[0] * n for _ in range(n)]
    time_secs = [[0] * n for _ in range(n)]
    speed = max(avg_speed_kmh, 1.0)
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            km = haversine_km(coords[i][0], coords[i][1], coords[j][0], coords[j][1]) * multiplier
            dist_cm[i][j] = int(round(km * 100_000))
            time_secs[i][j] = int(round(km / speed * 3600))
    return dist_cm, time_secs


# ---------------------------------------------------------------------------
# Mapbox Matrix provider
# ---------------------------------------------------------------------------


def _mapbox_call(
    coords_subset: list[tuple[float, float]],
    src_idx: list[int],
    dst_idx: list[int],
    token: str,
    profile: str,
) -> tuple[list[list[float | None]], list[list[float | None]]]:
    """One Mapbox Matrix call. Returns (distances_m, durations_s) for the sub-matrix.

    Coords are passed in Mapbox order: lng,lat (longitude first). NaN-safe;
    Mapbox returns ``null`` for unreachable pairs which we surface as ``None``
    to the caller (downstream we fall back to Haversine for those).
    """
    # Mapbox wants "lng,lat;lng,lat;..."
    path_coords = ";".join(f"{lng:.6f},{lat:.6f}" for lat, lng in coords_subset)
    url = f"{MAPBOX_BASE}/{profile}/{quote(path_coords)}"
    params = {
        "annotations": "distance,duration",
        "sources": ";".join(str(i) for i in src_idx),
        "destinations": ";".join(str(i) for i in dst_idx),
        "access_token": token,
    }

    last_err: Exception | None = None
    for attempt in range(HTTP_MAX_RETRIES):
        try:
            r = httpx.get(url, params=params, timeout=HTTP_TIMEOUT_SECS)
            if r.status_code == 429:
                # Rate-limited — wait and retry
                time.sleep(HTTP_RETRY_BACKOFF_SECS * (attempt + 1))
                continue
            r.raise_for_status()
            data = r.json()
            return data.get("distances") or [], data.get("durations") or []
        except (httpx.RequestError, httpx.HTTPStatusError) as exc:
            last_err = exc
            if attempt < HTTP_MAX_RETRIES - 1:
                time.sleep(HTTP_RETRY_BACKOFF_SECS * (attempt + 1))
                continue
    raise RuntimeError(f"Mapbox Matrix call failed after {HTTP_MAX_RETRIES} retries: {last_err}")


def mapbox_matrix(
    coords: list[tuple[float, float]],
    *,
    token: str,
    profile: str = "driving",
    haversine_fallback_multiplier: float = 1.30,
    haversine_fallback_speed_kmh: float = 40.0,
) -> tuple[list[list[int]], list[list[int]]]:
    """Distance + duration via Mapbox Directions Matrix.

    Tiles into MAX_PER_CALL × MAX_PER_CALL sub-matrices, executed in parallel
    over a thread pool. Any cell Mapbox returns as ``None`` (unreachable on
    the road network) falls back to a Haversine-multiplied estimate so the
    solver never sees NaN/None values.
    """
    n = len(coords)
    dist_cm = [[0] * n for _ in range(n)]
    time_secs = [[0] * n for _ in range(n)]

    # Build the list of (src_block_start, dst_block_start) batch tiles.
    tiles: list[tuple[int, int]] = []
    for src_start in range(0, n, MAX_PER_CALL):
        for dst_start in range(0, n, MAX_PER_CALL):
            tiles.append((src_start, dst_start))

    def run_tile(tile: tuple[int, int]) -> tuple[tuple[int, int], list[list[float | None]], list[list[float | None]]]:
        src_start, dst_start = tile
        src_end = min(src_start + MAX_PER_CALL, n)
        dst_end = min(dst_start + MAX_PER_CALL, n)
        src_range = list(range(src_start, src_end))
        dst_range = list(range(dst_start, dst_end))

        # Mapbox call needs ALL coords used + indices into that list for sources/destinations.
        all_indices = sorted(set(src_range) | set(dst_range))
        coords_subset = [coords[i] for i in all_indices]
        index_in_subset = {orig: pos for pos, orig in enumerate(all_indices)}
        src_idx = [index_in_subset[i] for i in src_range]
        dst_idx = [index_in_subset[i] for i in dst_range]

        distances, durations = _mapbox_call(coords_subset, src_idx, dst_idx, token, profile)
        return tile, distances, durations

    # Parallel HTTP. Mapbox documents 600 requests/minute; we stay well under.
    with ThreadPoolExecutor(max_workers=min(8, len(tiles))) as pool:
        futures = [pool.submit(run_tile, t) for t in tiles]
        for fut in as_completed(futures):
            (src_start, dst_start), distances, durations = fut.result()
            src_end = min(src_start + MAX_PER_CALL, n)
            dst_end = min(dst_start + MAX_PER_CALL, n)
            for si, src_i in enumerate(range(src_start, src_end)):
                for di, dst_i in enumerate(range(dst_start, dst_end)):
                    if src_i == dst_i:
                        continue
                    d_m = distances[si][di] if distances else None
                    t_s = durations[si][di] if durations else None
                    if d_m is None or t_s is None:
                        # Mapbox says unreachable — fall back to Haversine.
                        km = haversine_km(*coords[src_i], *coords[dst_i]) * haversine_fallback_multiplier
                        dist_cm[src_i][dst_i] = int(round(km * 100_000))
                        time_secs[src_i][dst_i] = int(round(km / max(haversine_fallback_speed_kmh, 1.0) * 3600))
                    else:
                        dist_cm[src_i][dst_i] = int(round(float(d_m) * 100))  # meters → cm
                        time_secs[src_i][dst_i] = int(round(float(t_s)))

    return dist_cm, time_secs


# ---------------------------------------------------------------------------
# OSRM provider — real road distance/duration via /table endpoint
# ---------------------------------------------------------------------------


def osrm_table(
    coords: list[tuple[float, float]],
    *,
    haversine_fallback_multiplier: float,
    haversine_fallback_speed_kmh: float,
) -> tuple[list[list[int]], list[list[int]]]:
    """Call OSRM /table for the full n×n matrix.

    Coords are (lat, lng) tuples; OSRM expects ``lng,lat`` in the URL.
    Returns (distance_cm, time_secs) in the same shape and units as
    haversine_matrix and mapbox_matrix.

    If OSRM is unreachable or returns garbage, every cell falls back to
    Haversine × multiplier so the solver never sees a partial matrix.
    """
    n = len(coords)
    dist_cm = [[0] * n for _ in range(n)]
    time_secs = [[0] * n for _ in range(n)]

    # OSRM accepts an arbitrarily long coordinate list in one call. The
    # /table endpoint returns a full n×n matrix per call. We still chunk
    # only because very long URLs trip some proxies.
    coord_str = ";".join(f"{lng:.6f},{lat:.6f}" for (lat, lng) in coords)
    url = f"{OSRM_URL}/table/v1/driving/{quote(coord_str, safe=';,')}?annotations=distance,duration"

    last_exc: Exception | None = None
    for attempt in range(HTTP_MAX_RETRIES):
        try:
            with httpx.Client(timeout=HTTP_TIMEOUT_SECS) as client:
                r = client.get(url, headers={"User-Agent": "RouteIQ-Solver/1.0"})
                r.raise_for_status()
                body = r.json()
            if body.get("code") != "Ok":
                raise ValueError(f"OSRM returned non-Ok code: {body.get('code')}")
            distances = body.get("distances") or []
            durations = body.get("durations") or []
            if len(distances) != n or len(durations) != n:
                raise ValueError(f"OSRM returned wrong matrix shape: {len(distances)}x?, expected {n}x{n}")
            for i in range(n):
                if len(distances[i]) != n or len(durations[i]) != n:
                    raise ValueError(f"OSRM row {i} wrong length")
                for j in range(n):
                    if i == j:
                        continue
                    d_m = distances[i][j]
                    t_s = durations[i][j]
                    if d_m is None or t_s is None:
                        # OSRM marks unreachable cells as null. Fall back to
                        # Haversine for those specific cells so the matrix
                        # stays complete.
                        km = haversine_km(coords[i][0], coords[i][1], coords[j][0], coords[j][1]) * haversine_fallback_multiplier
                        dist_cm[i][j] = int(round(km * 100_000))
                        time_secs[i][j] = int(round(km / max(haversine_fallback_speed_kmh, 1) * 3600))
                    else:
                        dist_cm[i][j] = int(round(float(d_m) * 100))  # meters → cm
                        time_secs[i][j] = int(round(float(t_s)))
            return dist_cm, time_secs
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            log.warning("OSRM attempt %d failed: %s", attempt + 1, exc)
            if attempt < HTTP_MAX_RETRIES - 1:
                time.sleep(HTTP_RETRY_BACKOFF_SECS * (attempt + 1))
    raise RuntimeError(f"OSRM /table failed after {HTTP_MAX_RETRIES} attempts: {last_exc}")


# ---------------------------------------------------------------------------
# Public entry point used by solver.py
# ---------------------------------------------------------------------------


def build_matrices(
    provider: str,
    tenant_id: str,
    coords: list[tuple[float, float]],
    *,
    haversine_multiplier: float,
    avg_speed_kmh: float,
    mapbox_token: str | None = None,
    mapbox_profile: str = "driving",
    use_cache: bool = True,
) -> tuple[list[list[int]], list[list[int]], dict]:
    """Returns (distance_cm, time_secs, meta).

    ``meta`` describes which provider was actually used so the FastAPI response
    can populate ``distance_is_estimated`` correctly. If Mapbox is requested
    but the call fails, we fall back to Haversine and record that in meta.
    """
    cache_suffix = f"speed={avg_speed_kmh:.1f}|mult={haversine_multiplier:.2f}|profile={mapbox_profile}"
    cache_key = _coords_cache_key(provider, tenant_id, coords, cache_suffix)
    if use_cache and cache_key in _MATRIX_CACHE:
        dist_cm, time_secs = _MATRIX_CACHE[cache_key]
        return dist_cm, time_secs, {"provider_used": provider, "cached": True}

    meta: dict = {"provider_used": provider, "cached": False}
    if provider == "MAPBOX_MATRIX":
        token = mapbox_token or os.environ.get("MAPBOX_TOKEN") or ""
        if not token:
            log.warning("MAPBOX_TOKEN missing; falling back to Haversine for tenant=%s", tenant_id)
            meta = {"provider_used": "HAVERSINE", "cached": False, "fallback_reason": "MAPBOX_TOKEN_MISSING"}
            dist_cm, time_secs = haversine_matrix(coords, haversine_multiplier, avg_speed_kmh)
        else:
            try:
                dist_cm, time_secs = mapbox_matrix(
                    coords,
                    token=token,
                    profile=mapbox_profile,
                    haversine_fallback_multiplier=haversine_multiplier,
                    haversine_fallback_speed_kmh=avg_speed_kmh,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("Mapbox Matrix failed (%s); falling back to Haversine", exc)
                meta = {"provider_used": "HAVERSINE", "cached": False, "fallback_reason": f"MAPBOX_ERROR: {exc}"}
                dist_cm, time_secs = haversine_matrix(coords, haversine_multiplier, avg_speed_kmh)
    else:
        # HAVERSINE — but if OSRM_URL is set, we transparently upgrade to OSRM
        # so the SOLVER receives real road distance/time instead of straight-line
        # × 1.30. That's the only way to eliminate the "zig-zag" routes that
        # come from PyVRP being fooled by Haversine "this pair is close" when
        # the road network actually requires a long detour. If OSRM fails for
        # any reason, fall back to real Haversine so the solver never blocks.
        if OSRM_URL:
            try:
                dist_cm, time_secs = osrm_table(
                    coords,
                    haversine_fallback_multiplier=haversine_multiplier,
                    haversine_fallback_speed_kmh=avg_speed_kmh,
                )
                meta = {"provider_used": "OSRM", "cached": False, "osrm_url": OSRM_URL}
            except Exception as exc:  # noqa: BLE001
                log.warning("OSRM matrix failed (%s); falling back to Haversine", exc)
                meta = {"provider_used": "HAVERSINE", "cached": False, "fallback_reason": f"OSRM_ERROR: {exc}"}
                dist_cm, time_secs = haversine_matrix(coords, haversine_multiplier, avg_speed_kmh)
        else:
            dist_cm, time_secs = haversine_matrix(coords, haversine_multiplier, avg_speed_kmh)

    if use_cache:
        # FIFO eviction
        if len(_MATRIX_CACHE) >= _MATRIX_CACHE_MAX:
            _MATRIX_CACHE.pop(next(iter(_MATRIX_CACHE)))
        _MATRIX_CACHE[cache_key] = (dist_cm, time_secs)

    return dist_cm, time_secs, meta


def clear_cache() -> None:
    """Test helper — clears the in-process matrix cache."""
    _MATRIX_CACHE.clear()
