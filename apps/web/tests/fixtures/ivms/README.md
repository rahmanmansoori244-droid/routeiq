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
- `day-script.json`: a whole invented delivery day for `tests/lib/ivms-day-simulation.spec.ts` (trucks' tracks as metre offsets from the invented depot of `tests/lib/ivms-trail.ts`, the drivers' and the office's entries, Ayun's webhooks and the provider's quirks: a coverage gap, points buffered and received late, a forged, a repeated and a foreign webhook). The spec's fake Ayun renders it in the shapes above.
- `detector-golden.json`: what the GPS stop detector at eb59226 (before the owner request of 19 Oct 2026: frozen runs, site radius, merged stays, held departures) proposed for 160 seeded invented truck-days (`tests/lib/ivms-detector-golden-cases.ts`): the first 8 in full, a fingerprint of each. `tests/lib/ivms-detector-golden.spec.ts` checks that the detector of today proposes the same where none of the new rules applies. Written once by that version (kept in the scratchpad, never in the repo), never by hand.
