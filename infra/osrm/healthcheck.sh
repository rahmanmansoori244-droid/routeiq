#!/bin/sh
# Health check of a RouteIQ OSRM server (audit F19), used by docker-compose.yml.
#
# Asks the running server for the nearest road to the Muscat depot (58.3920,23.5680, inside the
# Oman + UAE graph) and passes only on HTTP 200 with "code":"Ok" - the same probe the solver's
# /health uses. `osrm-routed --version` (the old check) passed even when the server was hung or
# had no graph loaded. Bounded: the request gets at most OSRM_HEALTH_TIMEOUT seconds (default 4,
# under the compose timeout of 5 s), so a hung server fails the check instead of hanging it.
#
# Works with curl, wget or bash: the debian OSRM image has bash and coreutils but no curl in its
# runtime stage. OSRM_HEALTH_CLIENT=curl|wget|bash forces one (tests); OSRM_HEALTH_HOST / _PORT
# change the address (default 127.0.0.1 and $PORT, 5000).
#   sh infra/osrm/healthcheck.sh && echo healthy
set -u
HOST="${OSRM_HEALTH_HOST:-127.0.0.1}"
PORT="${OSRM_HEALTH_PORT:-${PORT:-5000}}"
T="${OSRM_HEALTH_TIMEOUT:-4}"
QUERY="/nearest/v1/driving/58.3920,23.5680?number=1"
CLIENT="${OSRM_HEALTH_CLIENT:-auto}"

have() { command -v "$1" >/dev/null 2>&1; }
fail() { echo "osrm healthcheck: $*" >&2; exit 1; }

if [ "$CLIENT" = auto ]; then
  if have curl; then CLIENT=curl; elif have wget; then CLIENT=wget; elif have bash; then CLIENT=bash; else fail "no curl, wget or bash in this image"; fi
fi

case "$CLIENT" in
  curl)
    body=$(curl -fsS --max-time "$T" "http://${HOST}:${PORT}${QUERY}" 2>/dev/null) || fail "no HTTP 200 from /nearest within ${T}s"
    ;;
  wget)
    if have timeout; then
      body=$(timeout "$T" wget -q -O - -T "$T" "http://${HOST}:${PORT}${QUERY}" 2>/dev/null) || fail "no HTTP 200 from /nearest within ${T}s"
    else
      body=$(wget -q -O - -T "$T" "http://${HOST}:${PORT}${QUERY}" 2>/dev/null) || fail "no HTTP 200 from /nearest within ${T}s"
    fi
    ;;
  bash)
    have timeout || fail "bash client needs timeout (coreutils)"
    # A plain HTTP/1.0 request over bash's /dev/tcp. The output read before the deadline is kept
    # even when timeout stops it, so a server that answers but keeps the connection open passes.
    body=$(timeout "$T" bash -c 'exec 3<>"/dev/tcp/$0/$1" || exit 1; printf "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n" "$2" "$0" >&3; cat <&3' "$HOST" "$PORT" "$QUERY" 2>/dev/null)
    printf '%s\n' "$body" | head -n 1 | grep -Eq '^HTTP/[0-9.]+ 200' || fail "no HTTP 200 from /nearest within ${T}s"
    ;;
  *)
    fail "unknown OSRM_HEALTH_CLIENT=$CLIENT"
    ;;
esac

printf '%s' "$body" | grep -Eq '"code"[[:space:]]*:[[:space:]]*"Ok"' || fail "/nearest did not answer \"code\":\"Ok\" (no road near the Muscat depot: wrong or unloaded map?)"
exit 0
