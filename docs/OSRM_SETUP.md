# Road routing (OSRM) for RouteIQ

RouteIQ plans on **road** distance and time. They come from an OSRM server whose address is **configuration**:

- `OSRM_URL` environment variable of the **solver** service, or
- `TenantConfig.osrmUrl` (overrides the env var for one tenant).

There is **no silent default**. If neither is set, plans are produced with straight-line × 1.3 distances and are clearly labelled **Estimated km**, with a warning.

> The public demo server `https://router.project-osrm.org` is **for local demos only**. It is rate-limited, has no uptime guarantee and receives your customer coordinates. `.dev/start-solver.sh` uses it for the local demo only.

## Self-hosted OSRM (recommended for NMWC)

Oman + UAE extract, car profile (durations are scaled for trucks by `roadTimeFactor`, default 1.25):

```bash
mkdir osrm && cd osrm
curl -LO https://download.geofabrik.de/asia/gcc-states-latest.osm.pbf
docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/gcc-states-latest.osm.pbf
docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/gcc-states-latest.osrm
docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/gcc-states-latest.osrm
docker run -d --restart unless-stopped -p 5000:5000 -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-routed --algorithm mld --max-table-size 500 /data/gcc-states-latest.osrm
```

Then set `OSRM_URL=http://<host>:5000` on the solver.

- A small VM (2 vCPU / 4 GB) is enough for the GCC extract. Re-run the extract monthly to pick up new roads.
- The solver tiles table requests into 90×90 blocks, so the default `--max-table-size` also works; raising it only reduces the number of calls.

## Behaviour on failure
- OSRM unreachable or errors after 2 retries → the whole matrix falls back to Haversine, the plan shows `ROUTING_PROVIDER_FAILURE … distances are ESTIMATED`, and every km is labelled estimated.
- Individual unroutable legs (OSRM returns `null`) are patched with an estimate and counted in a warning.
- Road geometry for the map uses the same OSRM (`POST /route-geometry`). Without it, dashed straight lines are drawn.
