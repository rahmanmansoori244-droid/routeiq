# RouteIQ road-routing server: OSRM with the Oman (+ UAE) road network baked into the image.
#
# The routing graph is built at IMAGE BUILD time, so the running container needs no volume and
# starts in seconds. Refresh the map by rebuilding the image (monthly is plenty): see
# docs/OSRM_SETUP.md.
#
#   docker build -t routeiq-osrm infra/osrm
#   docker run -d -p 127.0.0.1:5000:5000 routeiq-osrm
#
# OSRM has NO authentication. Run it only on a private network (Railway private networking, a
# VM firewall, the NMWC LAN); never give it a public domain.

ARG OSRM_IMAGE=ghcr.io/project-osrm/osrm-backend:v26.9.0-debian

FROM ${OSRM_IMAGE} AS build
# Geofabrik GCC extract (updated daily). Clipped to Oman + UAE: Musandam and Buraimi deliveries
# drive through the UAE, so UAE roads are needed for correct Oman routing. Saudi/Qatar/Kuwait/
# Bahrain are dropped to keep the graph (and the server's RAM) small.
ARG PBF_URL=https://download.geofabrik.de/asia/gcc-states-latest.osm.pbf
# lon_min,lat_min,lon_max,lat_max
ARG BBOX=51.5,16.4,60.0,26.6
# Car profile: durations are scaled for trucks by the solver (road_time_factor, default 1.25).
ARG PROFILE=/opt/car.lua

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl osmium-tool \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /data
RUN curl -fsSL --retry 3 --retry-delay 10 -o source.osm.pbf "${PBF_URL}" \
 && osmium fileinfo -e source.osm.pbf | grep -m1 -i "timestamp" > SOURCE_TIMESTAMP || true \
 && osmium extract --strategy smart --bbox "${BBOX}" --overwrite -o region.osm.pbf source.osm.pbf \
 && rm source.osm.pbf \
 && osrm-extract -p "${PROFILE}" region.osm.pbf \
 && osrm-partition region.osrm \
 && osrm-customize region.osrm \
 && rm region.osm.pbf \
 && printf 'source=%s\nbbox=%s\nprofile=%s\nbuilt_at=%s\n' "${PBF_URL}" "${BBOX}" "${PROFILE}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > BUILD_INFO

FROM ${OSRM_IMAGE}
COPY --from=build /data /data
ENV PORT=5000 \
    OSRM_BIND=0.0.0.0 \
    MAX_TABLE_SIZE=1000
EXPOSE 5000
# MAX_TABLE_SIZE: the solver asks for 90x90 tiles, so the default is plenty; raising it only
# reduces the number of calls. OSRM_BIND=:: listens on IPv6 (Railway private networking).
CMD ["sh", "-c", "exec osrm-routed --algorithm mld --ip \"${OSRM_BIND}\" --port \"${PORT}\" --max-table-size \"${MAX_TABLE_SIZE}\" /data/region.osrm"]
