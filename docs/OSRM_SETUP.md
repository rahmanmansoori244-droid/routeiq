# Road routing (OSRM) for RouteIQ — production runbook

RouteIQ plans on **road** distances and times from an OSRM server. The solver reads the server's address from **`OSRM_URL`** (solver service environment). `TenantConfig.osrmUrl` can override it for one tenant.

There is no silent default:
- **No URL configured:** plans still work, but use straight-line × 1.3, every km is labelled **Estimated**, and a warning is shown.
- **Server down:** the same fallback applies, plus a `ROUTING_PROVIDER_FAILURE` warning. The evening plan is never blocked by routing.

> `https://router.project-osrm.org` is a public **demo** server: rate-limited, with no uptime guarantee, and it receives customer coordinates. Use it for local demos only (`.dev/start-solver.sh`), never in production.

## What is in the repo

| File | Purpose |
|---|---|
| `infra/osrm/Dockerfile` | Pinned OSRM `v26.9.0`. Downloads the Geofabrik GCC extract, clips it to **Oman + UAE** (the UAE is needed for Musandam/Buraimi routes), and builds the routing graph (`car` profile, MLD) **at image build time**. The container needs no volume and starts in seconds. |
| `infra/osrm/railway.json` | Railway service config: Dockerfile builder, health check on a Muscat `/nearest` query, 1 replica. |
| `infra/osrm/docker-compose.yml` | Same image on a VM or the NMWC on-prem server, bound to `127.0.0.1:5000`. |
| `infra/osrm/smoke-test.sh` | Proves real road routes: Ghala → Ruwi / Seeb / Barka / Nizwa within expected km, Ghala → Khasab via the UAE, and a 100×100 table. |
| `.github/workflows/osrm.yml` | Builds the image and runs the smoke test on every PR that touches `infra/osrm`. Validation only; nothing is published. |

Build needs ~4 GB RAM and ~10 min. Running needs ~0.5–1 GB RAM and <1 vCPU. Truck speeds: OSRM durations come from the car profile and are multiplied by the solver's `roadTimeFactor` (1.25).

**Security.** OSRM has **no authentication**. It must only be reachable on a private network (Railway private networking, the VM's localhost or LAN, the NMWC network). Never attach a public domain or open port 5000 to the internet.

## Option A — Railway (same project as the web app and solver)

Railway is where RouteIQ was deployed before. The CLI must be logged in by you (`railway login` opens a browser).

```bash
railway login
cd C:/Users/abdulr/routeiq
railway link                                   # pick the RouteIQ project + production environment
railway add --service routeiq-osrm             # new empty service
```

In the Railway dashboard, `routeiq-osrm` service:

1. **Settings → Source:** connect the GitHub repo `rahmanmansoori244-droid/routeiq`, branch `main`.
2. **Root directory:** `infra/osrm` (Railway then uses `infra/osrm/railway.json` and the Dockerfile).
3. **Variables:** `OSRM_BIND=::`. Railway's private network is IPv6; `::` also accepts IPv4.
4. **Networking:** do **not** generate a public domain. The private address is `routeiq-osrm.railway.internal`.
5. **Resources:** 1 GB RAM is enough at runtime. The build uses Railway's builder.

On the **solver** service, set:
```
OSRM_URL=http://routeiq-osrm.railway.internal:5000
```
Then redeploy the solver.

Costs are usage-based: roughly 1 GB RAM running continuously plus a monthly rebuild. Check the Railway dashboard; it's usually well under 10 USD/month.

## Option B — any Linux VM or the NMWC on-prem server (Docker)

```bash
git clone https://github.com/rahmanmansoori244-droid/routeiq.git && cd routeiq
docker compose -f infra/osrm/docker-compose.yml up -d --build
OSRM_URL=http://127.0.0.1:5000 sh infra/osrm/smoke-test.sh
```

- If the solver runs on another machine, change the port binding to the host's **private** LAN IP (e.g. `10.0.0.5:5000:5000`) and firewall it to the solver's IP.
- Set `OSRM_URL=http://<private-ip>:5000` on the solver.
- A 2 vCPU / 4 GB VM (Hetzner CX22, DigitalOcean Basic…) is enough, and also covers the build.

## Verify in production

1. `GET https://<web>/api/health` should return `"routing": { "provider": "OSRM", "status": "up" }`.
   - `not_configured`: `OSRM_URL` is missing on the solver.
   - `down`: the solver can't reach OSRM.
2. Optimize a day: the plan screen shows **"Road km"** (not "Estimated km"), and no routing warning appears.
3. Optionally, from inside the private network: `OSRM_URL=… sh infra/osrm/smoke-test.sh`.

Monitoring: alert when `/api/health` → `routing.status` is not `up` for more than 10 minutes. Plans keep working in the meantime, but with estimated distances.

## Monthly map refresh
OpenStreetMap changes (new roads, closures). Rebuild the image about monthly:
- **Railway:** service → Deployments → **Redeploy** (with build cache off), or push any change under `infra/osrm/`.
- **Docker host:**
  ```bash
  docker compose -f infra/osrm/docker-compose.yml build --pull --no-cache && docker compose -f infra/osrm/docker-compose.yml up -d
  ```
  (a monthly cron works).

`docker run --rm --entrypoint cat routeiq-osrm /data/BUILD_INFO` shows the source, bounding box and build time.

## Calibrating truck times (recommended after go-live)
`roadTimeFactor` (TenantConfig, default 1.25) converts OSRM car times into truck times.
1. Compare planned vs actual load durations for a few weeks. Actual trip times are available from the Ayun IVMS history and OPERATION-PROJECT Lane A.
2. Set the factor to the median ratio.
3. If a single factor is not enough (e.g. highway vs city), switch the image to a custom truck Lua profile via the `PROFILE` build argument.

## Rollback
Remove or blank `OSRM_URL` on the solver and redeploy. Plans immediately fall back to estimated distances, with warnings. The OSRM service can be deleted without any data loss; it holds no RouteIQ data.
