# Fake Ayun answers (IVMS live link tests)

Hand-written in the documented shape of the GPS-Server.net user API 1.x and its webhook. Nothing here was
copied from a real answer: the IMEIs are the vendor documentation's dummies (111111111111111 and
222222222222222), the names are invented ("Example object A"), the positions are offsets around an
invented origin (10.5 N, 20.5 E) and the times are on 16 Oct 2026 in UTC.

- `locations.json`: OBJECT_GET_LOCATIONS for both dummies (every value a string, as the provider sends).
- `route.json`: OBJECT_GET_ROUTE of one tracker (points as `[dt_tracker, lat, lng, altitude, angle, speed, params]`).
- `last-events.json`: OBJECT_GET_LAST_EVENTS (`[type, event_desc, imei, name, dt_tracker, lat, lng, altitude, angle, speed, params]`).
- `objects.json`: USER_GET_OBJECTS.
- `webhook-depot-in.txt`: the query string of a "Depot IN" webhook call, with the fields RouteIQ never reads.
- An empty answer is `[]`; an error is plain text such as `ERROR: wrong API key` with HTTP 200 (inline in the specs).
