#!/usr/bin/env sh
# Smoke test for a RouteIQ OSRM server: real Muscat routes must come back as road distances.
#   OSRM_URL=http://localhost:5000 sh infra/osrm/smoke-test.sh
set -eu
URL="${OSRM_URL:-http://localhost:5000}"
fail() { echo "FAIL: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing tool: $1"; }
need curl
need jq

# Ghala depot -> Ruwi, Seeb, Barka, Nizwa (lng,lat order for OSRM)
PTS="58.3920,23.5680;58.5430,23.5980;58.1890,23.6700;57.8895,23.6786;57.5290,22.9330"
BODY=$(curl -fsS --max-time 30 "${URL}/table/v1/driving/${PTS}?annotations=distance,duration&sources=0") \
  || fail "table request failed"
[ "$(echo "$BODY" | jq -r .code)" = "Ok" ] || fail "OSRM code: $(echo "$BODY" | jq -r .code)"

check() { # name index min_km max_km
  km=$(echo "$BODY" | jq -r ".distances[0][$2] / 1000 | floor")
  [ "$km" -ge "$3" ] && [ "$km" -le "$4" ] || fail "$1: ${km} km not in [$3, $4]"
  echo "ok  Ghala -> $1: ${km} km by road"
}
check Ruwi 1 12 35
check Seeb 2 20 45
check Barka 3 50 90
check Nizwa 4 130 200

# Musandam (Khasab) is only reachable through the UAE: proves the UAE part of the graph is there.
KHASAB=$(curl -fsS --max-time 30 "${URL}/route/v1/driving/58.3920,23.5680;56.2460,26.1790?overview=false" | jq -r '.routes[0].distance / 1000 | floor')
[ "$KHASAB" -ge 450 ] && [ "$KHASAB" -le 800 ] || fail "Khasab route ${KHASAB} km unexpected"
echo "ok  Ghala -> Khasab (via UAE): ${KHASAB} km by road"

# Table of 100 points must work with the default max-table-size.
MANY=$(awk 'BEGIN{for(i=0;i<100;i++){printf "%s%.5f,%.5f", (i?";":""), 58.10+i*0.004, 23.55+(i%10)*0.004}}')
[ "$(curl -fsS --max-time 60 "${URL}/table/v1/driving/${MANY}" | jq -r .code)" = "Ok" ] || fail "100x100 table failed"
echo "ok  100x100 table"
echo "SMOKE TEST PASSED"
