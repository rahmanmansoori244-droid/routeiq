# Delivery outcome and the driver phone page

Build spec, 4 Oct 2026. Design only: nothing in any repository was changed to write it.

**Revision 2 (4 Oct 2026, after a 30-point critique).** Every point is answered in the "Critique log" at the end (accepted, accepted with a change, or rejected, each with a one-line reason). The main changes: the driver API no longer carries the token in its path; late driver actions can only fill gaps after a trip is closed; the stop timer only counts what the page really saw; the page survives a reload, a dead zone and a killed camera tab; today's not-delivered orders are ticked only once the truck is back; locations are kept 90 days.

- **Base.** `main` at ad24be2 (live on Railway). Build branch `delivery-outcome-driver-page` in the worktree `C:/Users/abdulr/routeiq-wt-driver`.
- **Line numbers** are those of ad24be2. Every change is also named by its function, so it can still be found after other merges.
- **Data.** Every example below is synthetic: customers ACME, BETA and the rest, trucks T01 to T05, drivers Salim and Khalid. No real customer data appears anywhere in this spec, in the tests or in the docs.

## 0. What the owner asked for (4 Oct 2026)

1. Build the **delivery outcome** and the **driver phone page** now.
2. Keep the PDF driver sheets for the record. Add a **QR code per driver** that opens his own page, with his plan and his orders.
3. When the driver reaches the customer, a **timer starts by itself** and measures the stop (unloading) time. This feeds real data into the system.
4. The driver takes a **photo as proof**, and the photo's location is captured.
5. NMWC also uses **casual (daily) drivers** and sometimes **rents trucks**.
6. The **Ayun tracking link comes later**. The stop-event data is designed so Ayun events can go into the same table.

The owner rules already live are kept unchanged:
- exact customer locations;
- every order has a depot;
- the location lock (a dispatcher fills a missing location, only an admin changes a saved one);
- the loading rule and the data-to-collect list;
- the delivery time set per order;
- frozen loads never change;
- the shift, the break and "unloading finished by closing";
- only the dispatcher uses RouteIQ day to day (the driver page is the one exception, and it needs no account);
- Bring forward;
- rule 20: a load never leaves without a driver.

## 1. What the code does today (findings that shape the design)

| # | Finding | Where | Consequence |
|---|---|---|---|
| F1 | **Module C (the old driver PWA) is retired.** Every `/api/driver/*` route, the PIN route and the live route answer 410 through `driverAppGone()`. `/driver` shows a "retired" notice and clears the old localStorage keys. The tables `DriverShift`, `TruckLocation` and `DeliveryProof` and the column `Driver.accessPinHash` are kept until the owner allows them to be dropped. | `lib/driver-app.ts`, `lib/driver-auth.ts`, `app/api/driver/*`, `app/driver/*`, `tests/integration/driver-app-retired.spec.ts` | Module C stays exactly as it is. The new page lives at **`/d/<token>`** (the QR landing page only) with its API at the token-free paths **`/api/d/*`**, the token travelling in a header (§5). These paths are deliberately not `/driver` or `/api/driver`: `tests/lib/repo-guards.spec.ts` ("the legacy driver app is retired") fails if a screen calls `/api/driver/`, and its regex also catches `/pin` and `/live` path endings, so the new code avoids them too. `DeliveryProof` cannot be reused: it hangs off one `RouteAssignment` (one row per plan version, deleted with the version) and off a PIN shift. |
| F2 | **Plan versions copy their loads.** `createNextVersion` (plan-service.ts:1977) copies EVERY load and its stops into the new version, with new ids (`carriedFromLoadId` = the parent's load). A re-plan can run while loads are DISPATCHED (`REPLAN_FROM` includes DISPATCHED). | `plan-service.ts` 1995-2054 | An outcome must not hang off a `PlanLoad` id or a `RouteAssignment` id. It is keyed by the **physical stop**: `(tenantId, depotId, deliveryDate, truckId, loadNo, sequence)`. DISPATCHED and COMPLETED loads are frozen, so a copy keeps its truck, its load number and its stop sequence verbatim (`@@unique([runId, truckId, loadNo])`; `sequenceInTruck` is per load). |
| F3 | **Bring forward treats anything that left as delivered.** `carryCandidates` skips orders with status DISPATCHED or DELIVERED (carry-over.ts:264). `windowOrders` filters them out in SQL (carry-over.ts:587). The cases on loads that left (`LEFT_DEPOT`) count as delivered (carry-over.ts:274). `changeStatusTx` sets `Order.status = DISPATCHED` once every part of an order is out (plan-service.ts:2240). | `carry-over.ts`, `plan-service.ts` | This is the gap to close (D7): outcomes must reach both the SQL filter and the pure function. `Order.status` keeps its meaning. Several places read DISPATCHED as "left, do not plan on its own day": `day-overview.ts:229`, `plan-detail.ts:978`, `plan-service.ts:403, 1255`. `OrderStatus.DELIVERED` and `FAILED` stay unused. |
| F4 | **Rule 20 is not enforced.** `changeStatusTx` never checks `driverId`. Many unit and integration tests dispatch loads without a driver (§18.3). | `plan-service.ts:2196` | Part 1 adds a gate and updates those tests. |
| F5 | **Drivers and trucks are master data owned by the admin.** `POST /api/drivers` and `POST /api/trucks` require TENANT_ADMIN. The driver is set per load (`setDriverTx`). A driver cannot change after dispatch (`checkDriverChange`). Every active truck of the depot is planned every day (plan-service.ts:347): there is no per-day truck availability. | `app/api/drivers`, `app/api/trucks`, `load-state.ts` | A dispatcher (PLANNER) cannot add a daily driver or a hired truck today. D11 adds a quick daily-driver path. D12 adds only a "hired" flag (§15). |
| F6 | **One truck can have different drivers on different loads** (the driver is per load). | `PlanLoad.driverId` | One link per truck-day covers all its loads (D1). The audit names the driver of the load the action was on. |
| F7 | **Driver sheets already draw QR codes** as vector paths (`qrPath`, driver-pack.tsx:259) with the `qrcode` package. The PDF route is readable by every role, VIEWER included (`withTenantApi` without a role). | `driver-pack.tsx`, `app/api/runs/[id]/export/pdf/route.ts` | `qrPath` is reused. The driver-link QR is printed only when the person asking is PLANNER or above, because the link can write outcomes (§16). |
| F8 | **The WhatsApp text is per load** and pure (`whatsappText`, driver-links.ts:146). The plan screen builds it in the browser. | `driver-links.ts`, `plan-view.tsx:898` | It gets an optional driver-link line. |
| F9 | **Infrastructure the design can reuse:** the in-memory `RateLimiter` (single web replica); the in-process janitor every 60 s; the audit catalog, whose repo guard needs a handbook 3.13 row per action; `tenantDb` with `TENANT_SCOPED_MODELS`; the hashed-token pattern of `password-reset.ts`; advisory locks in `plan-locks.ts`; `distanceM` (snapshots.ts:307); `todayIso`, `zonedDayStart` and `localMinutes` (time.ts); `rowLines` (split.ts:266); `readStopSnapshot` and `readPromised`; `clientIp` (client-ip.ts, which can return null and already knows the internal ranges); `effectiveAttrs` (customer-attrs.ts) for the effective unloading time; `PlanLoad.breakJson` (`parseLoadBreak`) for the planned break. | | No new npm dependency and no external service is needed. The EXIF reader is about 150 lines of our own code. The offline queue uses the raw IndexedDB API. The service worker (§13.4) is one small hand-written file. |
| F12 | **A brought-forward copy cannot be deleted once it was planned.** `RouteAssignment.orderId` is `ON DELETE RESTRICT`, `UnservedOrder.orderId` is `NO ACTION`, and every plan version copies its assignment rows (F2). No route edits or cancels an order; the handbook (line ~2986) lists "no undo bring forward" as open, and planned orders "cannot be removed in the app at all until the deferred cancel flow exists" (owner decision F20). | `schema.prisma`, `carry-over.ts`, handbook | "Undo bring forward" (§9.4) can delete a copy only while no plan row refers to it. Removing a planned copy needs the deferred cancel flow (Q12). |
| F13 | **The client IP may be unknown or shared.** `clientIp` returns null when the header is missing and logs a warning when it resolves to an internal range; sign-in throttling then skips the per-IP counter (auth-credentials.ts:103). Railway's client-IP header is still unconfirmed (handbook 7.5). Drivers share the depot Wi-Fi in the morning, and mobile carriers use CGNAT. | `client-ip.ts`, `auth-credentials.ts` | No driver route ever blocks on an IP alone; only unknown tokens count against an IP (§5). |
| F14 | **Sentry samples 10 % of transactions in four places** (`sentry.client/server/edge.config.ts`, `lib/observability.ts`). `beforeSend` exists only in the client and server configs and runs for errors only, not for transactions or breadcrumbs. | Sentry configs | The token must never be in an API path, and every Sentry init drops traces of `/d/` (§16.1). |
| F10 | **The API role matrix** classifies every handler by pattern: PUBLIC, TOKEN, GONE, ANY or a role. A token route would show as PUBLIC. | `tests/lib/api-role-matrix.ts` | A new class **DRIVER_LINK** is added for handlers wrapped in `withDriverLink(`. |
| F11 | **The handbook guards count route files, migrations, models and enums,** and list every spec file in 5.3. | `repo-guards.spec.ts:433-456` | Each build part updates those counts for what it adds. |

## 2. Decisions

The coordinator decisions D1 to D13 hold, with the changes listed in §21. In short:

- **One link per truck-day.** One QR code and one link cover every load of one truck on one delivery date. There is no account, no PIN and no app to install. Casual drivers and drivers of hired trucks just scan.
- **The token is the only credential.** The QR opens `/d/<token>`; after that the page sends the token in a header to token-free API paths, so it reaches server logs once per page open. It is valid until 12:00 company time (Asia/Muscat) on the day after the delivery date for reading and new results, plus a **72-hour upload-only grace** so results waiting on a phone still arrive. It can be revoked, and "Reissue link" replaces it.
- **Outcomes, arrivals and departures are events** (`StopEvent`), with a source: PHONE_AUTO, PHONE_MANUAL, DISPATCHER, AYUN or SYSTEM. `StopVisit` holds the current state of each physical stop, rebuilt from its events. No continuous track is ever stored, and event positions are erased after 90 days (setting).
- **The timer only counts what the page saw.** An arrival seen only when the driver reopened the page is marked "not observed" and never feeds measured times or the on-time KPI.
- **After a trip is closed, the link can only fill gaps.** A late result is stored for a stop that had none, flagged "recorded after the trip closed", and never ticked by default in Bring forward.
- **Bring forward reads the shortfall from the outcomes.** A not-delivered order is listed and ticked by default once its result is final: earlier days always, today's group once the truck is back at the depot (or the load is Completed). A change that would shrink a shortfall already brought forward is refused; "Undo bring forward" removes a copy that is not planned yet.
- **Photos are stored compressed in PostgreSQL**, in their own table, stripped of all metadata. A retention janitor drops the photo bytes and keeps the metadata.
- **Module C stays retired and untouched** (F1).

## 3. Data model: one additive migration

Migration: `apps/web/prisma/migrations/20261004090000_delivery_outcome_driver_page/migration.sql`.
- It contains only `CREATE TYPE`, `CREATE TABLE`, `CREATE INDEX`, `ADD CONSTRAINT` and `ALTER TABLE ... ADD COLUMN` (nullable, or with a `DEFAULT`).
- It changes no existing data.
- It adds every table, enum and column needed by all three build parts, so Parts 2 and 3 need no migration.
- It uses no partial indexes: the drift check (`prisma migrate diff ... --exit-code`) must stay clean.
- It adds **4 models** and **5 enums**, and the handbook counts move with them.

```prisma
// --- Delivery outcome & driver page (owner request 4 Oct 2026) ---------------------------

enum StopEventKind {
  ARRIVED        // payload: chained?, observed (false = first seen when the page came back), resumed?
  DEPARTED       // payload: reason LEFT | NEXT_STOP, gap? (true = not observed: the page was away)
  OUTCOME        // payload: outcome (or null = result cleared), reason, note, lines, photoKeys, noPhotoReason?
  PHOTO          // payload: { photoId }
  BACK_AT_DEPOT  // load level: sequence is NULL
  CARRY_CONFLICT // a result change refused because the order was brought forward (§9.4); ignored by deriveVisit
}

enum PhotoPositionStatus {
  OK             // a fix with accuracy <= 100 m
  POOR           // a fix, accuracy > 100 m
  DENIED         // location permission refused
  TIMEOUT        // no fix within 15 s
  UNSUPPORTED    // no Geolocation in this browser
}

enum StopEventSource {
  PHONE_AUTO     // the driver page's geofence (no tap)
  PHONE_MANUAL   // the driver tapped (I have arrived, a result, a photo, Back at depot)
  DISPATCHER     // recorded or corrected on the plan screen
  AYUN           // later: Ayun GPS stop events (§17)
  SYSTEM         // derived by RouteIQ (for example the janitor completing a returned load)
}

enum DeliveryOutcome {
  DELIVERED
  PARTLY_DELIVERED
  NOT_DELIVERED
}

enum NotDeliveredReason {
  SHOP_CLOSED
  CUSTOMER_REFUSED
  NO_ONE_TO_RECEIVE
  WRONG_LOCATION      // "Wrong location or could not find"
  NO_TIME_LEFT
  PAYMENT_ISSUE
  DAMAGED_GOODS
  NOT_ON_TRUCK        // added (see §21): cases missing from the truck
  OTHER               // note required
}

/// One driver link per truck and delivery date (D1). The token is never stored: tokenHash is its
/// SHA-256 (lookup), and the token is re-derived on the server from (id, generation, salt) and the
/// server key (§4), so the plan screen and every PDF can show it again.
model DriverLink {
  id               String    @id @default(cuid())
  tenantId         String
  tenant           Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  truckId          String
  /// NO ACTION: a truck with links is deactivated, never deleted.
  truck            Truck     @relation(fields: [truckId], references: [id], onDelete: NoAction)
  deliveryDate     DateTime  @db.Date
  generation       Int       @default(1)
  salt             String    // 16 random bytes, base64url; new on every reissue
  keyId            String    // first 8 hex of SHA-256(server key): resolve refuses a link made with an older key
  tokenHash        String    @unique // SHA-256 hex of the token
  /// The hash of the generation before the last reissue: that token answers 410 LINK_REPLACED
  /// (never counted as a bad token) instead of 404.
  prevTokenHash    String?   @unique
  expiresAt        DateTime  @db.Timestamptz(3) // reading and new results; uploads get +72 h (§4.2)
  issuedAt         DateTime  @default(now()) @db.Timestamptz(3)
  issuedById       String?
  issuedBy         User?     @relation("DriverLinkIssuedBy", fields: [issuedById], references: [id], onDelete: SetNull)
  /// The driver of the truck-day's first load not yet COMPLETED when (re)issued: "Reissue link?" prompt.
  driverIdAtIssue  String?
  revokedAt        DateTime? @db.Timestamptz(3)
  revokedById      String?
  revokedBy        User?     @relation("DriverLinkRevokedBy", fields: [revokedById], references: [id], onDelete: SetNull)
  lastSeenAt       DateTime? @db.Timestamptz(3)
  /// Up to 5 browsers seen with this generation: [{ device: first 8 hex of sha256(deviceId), first, last }]
  /// (written at most every 5 min). The link dialog shows "used on N phones".
  devicesJson      Json?
  events           StopEvent[]
  photos           DeliveryPhoto[]

  @@unique([tenantId, truckId, deliveryDate])
  @@index([tenantId, deliveryDate])
}

/// One physical stop of a load that left the depot: the current state, rebuilt from its events
/// (lib/delivery/visit.ts). Keyed by the stop itself, never by a plan version's row (F2).
model StopVisit {
  id                  String           @id @default(cuid())
  tenantId            String
  tenant              Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  depotId             String
  deliveryDate        DateTime         @db.Date
  truckId             String
  truck               Truck            @relation(fields: [truckId], references: [id], onDelete: NoAction)
  loadNo              Int
  sequence            Int
  customerId          String
  customer            Customer         @relation(fields: [customerId], references: [id], onDelete: NoAction)
  /// Traceability only (no FK): the PlanLoad row of the version the first event was recorded on.
  firstLoadId         String?
  // The plan as it was for this stop (copied at the first write; frozen loads never change):
  plannedEtaMin       Int?
  plannedServiceMin   Int?             // departureMin - serviceStartMin (the scheduled unloading)
  plannedLat          Float?
  plannedLng          Float?
  windowStartMin      Int?             // promised time, else the hard receiving window; null = any time
  windowEndMin        Int?
  /// [{ orderId, lineId, productCode, plannedCases, deliveredCases|null }] (readVisitLines)
  linesJson           Json
  casesPlanned        Int
  casesDelivered      Int?             // null = no result
  // Timing (rebuilt from events):
  arrivedAt           DateTime?        @db.Timestamptz(3)
  arrivalSource       StopEventSource?
  arrivalDistanceM    Float?
  arrivalAccuracyM    Float?
  departedAt          DateTime?        @db.Timestamptz(3)
  departureSource     StopEventSource?
  departedAtOutcome   Boolean          @default(false) // no usable departure: the result time ended the stop
  /// false = the automatic arrival was first seen when the page came back (resumed), so its time
  /// is only an upper bound: never used for measured times or the on-time KPI (§8.4).
  arrivalObserved     Boolean          @default(true)
  autoArrivedAt       DateTime?        @db.Timestamptz(3) // an OBSERVED automatic arrival only
  autoDepartedAt      DateTime?        @db.Timestamptz(3) // an OBSERVED automatic departure only
  autoBasis           String?          // 'DEPARTURE' | 'RESULT': what ended the automatic timing
  autoMinutes         Float?           // observed auto arrival -> observed departure, else -> the driver's result time
  autoServiceMinutes  Float?           // the same, from max(arrival, window start), break excluded (§11.1)
  /// Plausibility flags of the phone-reported positions (§8.3): any flag excludes the visit from
  /// measured times, the on-time KPI and the pin check. The overlay says "unverified timing".
  timingSuspect       Boolean          @default(false)
  // Result (rebuilt from the latest OUTCOME event):
  outcome             DeliveryOutcome?
  reason              NotDeliveredReason?
  reasonNote          String?
  outcomeAt           DateTime?        @db.Timestamptz(3)
  outcomeSource       StopEventSource?
  outcomeById         String?
  outcomeBy           User?            @relation("StopVisitOutcomeBy", fields: [outcomeById], references: [id], onDelete: SetNull)
  outcomeLat          Float?
  outcomeLng          Float?
  outcomeAccuracyM    Float?
  outcomeDistanceM    Float?
  /// The current result came from an event received after the load was COMPLETED or after the
  /// link expired (§8.3): shown "recorded after the trip closed", never ticked in Bring forward.
  outcomeLate         Boolean          @default(false)
  noPhotoReason       String?          // 'CAMERA_FAILED' (the driver's only exception to "photo required")
  photoKeysJson       Json?            // photo keys the result named (shows "photo not received yet")
  photoCount          Int              @default(0)
  locationPurgedAt    DateTime?        @db.Timestamptz(3) // lat/lng/accuracy erased (§12.4); distances kept
  createdAt           DateTime         @default(now()) @db.Timestamptz(3)
  updatedAt           DateTime         @updatedAt @db.Timestamptz(3)
  events              StopEvent[]
  photos              DeliveryPhoto[]

  @@unique([tenantId, depotId, deliveryDate, truckId, loadNo, sequence])
  @@index([tenantId, deliveryDate])
  @@index([tenantId, customerId, deliveryDate])
}

/// Append-only log: what happened at a stop, from which source. Ayun (later) writes here too.
model StopEvent {
  id              String          @id @default(cuid())
  tenantId        String
  tenant          Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  depotId         String
  deliveryDate    DateTime        @db.Date
  truckId         String
  loadNo          Int
  sequence        Int?            // NULL = load level (BACK_AT_DEPOT)
  visitId         String?
  visit           StopVisit?      @relation(fields: [visitId], references: [id], onDelete: Cascade)
  kind            StopEventKind
  source          StopEventSource
  at              DateTime        @db.Timestamptz(3) // when it happened (device clock, corrected and clamped, §13)
  receivedAt      DateTime        @default(now()) @db.Timestamptz(3)
  lat             Float?
  lng             Float?
  accuracyM       Float?
  distanceM       Float?          // from the stop's planned pin (the depot pin for BACK_AT_DEPOT)
  speedMps        Float?
  driverLinkId    String?
  driverLink      DriverLink?     @relation(fields: [driverLinkId], references: [id], onDelete: SetNull)
  linkGeneration  Int?
  userId          String?
  user            User?           @relation("StopEventUser", fields: [userId], references: [id], onDelete: SetNull)
  clientIp        String?         // as AuditLog: who sent it (erased with the location, §12.4)
  deviceId        String?         // sha256 of the page's random per-browser id, first 16 hex (erased with the location)
  /// Namespaced on the server so sources cannot collide (§13.3): "dl:<uuid>" (driver action),
  /// "dlphoto:<uuid>" (driver photo), "disp:<uuid>" (dispatcher), "ayun:<id>" (later).
  idempotencyKey  String
  payloadJson     Json?           // also: late, clockSkewMs, gpsAt, suspect[]

  @@unique([tenantId, idempotencyKey])
  @@index([tenantId, deliveryDate, truckId])
  @@index([visitId, at])
}

/// A delivery photo: compressed JPEG in the database (D10). bytes = NULL once the retention
/// janitor dropped it; the metadata stays.
model DeliveryPhoto {
  id              String          @id @default(cuid())
  tenantId        String
  tenant          Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  visitId         String
  visit           StopVisit       @relation(fields: [visitId], references: [id], onDelete: Cascade)
  idempotencyKey  String
  source          StopEventSource
  driverLinkId    String?
  driverLink      DriverLink?     @relation(fields: [driverLinkId], references: [id], onDelete: SetNull)
  userId          String?
  user            User?           @relation("DeliveryPhotoUser", fields: [userId], references: [id], onDelete: SetNull)
  clientIp        String?
  deviceId        String?
  /// The capture time on the device clock, skew-corrected and clamped to
  /// [zonedDayStart(date) - 6 h, receivedAt] (§12.2). The raw value is in rawTakenAt.
  takenAt         DateTime        @db.Timestamptz(3)
  rawTakenAt      DateTime?       @db.Timestamptz(3)
  receivedAt      DateTime        @default(now()) @db.Timestamptz(3) // server time: retention runs on it
  positionStatus  PhotoPositionStatus
  lat             Float?
  lng             Float?
  accuracyM       Float?
  distanceM       Float?
  exifLat         Float?
  exifLng         Float?
  exifTakenAt     DateTime?       @db.Timestamptz(3) // parsed with OffsetTimeOriginal, else the tenant time zone
  exifDistanceM   Float?
  oldPhoto        Boolean         @default(false) // EXIF time or file time > 15 min before the arrival / dispatch
  contentType     String          @default("image/jpeg")
  byteSize        Int             // of the stored (metadata-stripped) bytes
  width           Int?
  height          Int?
  sha256          String          // of the stored (metadata-stripped) bytes
  bytes           Bytes?
  purgedAt        DateTime?       @db.Timestamptz(3)
  locationPurgedAt DateTime?      @db.Timestamptz(3)

  @@unique([tenantId, idempotencyKey])
  @@index([visitId])
  @@index([tenantId, receivedAt])
}
```

Columns added to existing models. Each has a default, so no existing row changes meaning.

| Model | Column | Default | Who sets it |
|---|---|---|---|
| `TenantConfig` | `geofenceRadiusM Int` | 100 | admin (Settings, 50-500) |
| `TenantConfig` | `photoProofRequired Boolean` | true | admin |
| `TenantConfig` | `photoRetentionDays Int` | 365 | admin (30-1095) |
| `TenantConfig` | `locationRetentionDays Int` | 90 | admin (30 .. `photoRetentionDays`): positions, IP and device id of driver events and photos are erased after it (§12.4) |
| `TenantConfig` | `dispatcherPhone String?` | null | admin: the number behind the driver page's "Call dispatcher" button (hidden while empty) |
| `TenantConfig` | `outcomesSince DateTime` | `now()` (the migration time for existing tenants) | nobody: the no-result list and the KPIs ignore deliveries before it (§9.1, §11.4) |
| `Order` | `carryBasisJson Json?` | null | `bringForward`, on the copy: the visits and not-delivered cases per line the carry was based on (§9.4) |
| `Driver` | `casual Boolean` | false | daily-driver quick add (true); admin may clear it |
| `Truck` | `hired Boolean` | false | admin (Trucks page): "Hired from outside" |

Back-relations are added to:
- `Tenant`: driverLinks, stopVisits, stopEvents, deliveryPhotos;
- `User`: four named relations;
- `Truck`: driverLinks, stopVisits;
- `Customer`: stopVisits.

`lib/tenant.ts` `TENANT_SCOPED_MODELS` gains `DriverLink`, `StopVisit`, `StopEvent` and `DeliveryPhoto`.

`readVisitLines(json)`, in `lib/delivery/visit.ts`, is the only reader of `linesJson`. Like `readPortionLines`, it drops malformed entries and never throws.

## 4. Driver link: the token and its lifecycle

### 4.1 Token

- **Server key.** `K = HKDF-SHA256(ikm, salt="routeiq-driver-link", info="v1", 32 bytes)`.
  - `ikm` = `DRIVER_LINK_SECRET` (optional new env), else `NEXTAUTH_SECRET`, else `AUTH_SECRET`.
  - Without any of them the link routes answer 503 `DRIVER_LINKS_OFF`. Production always has `NEXTAUTH_SECRET`.
  - `keyId = sha256hex(K).slice(0, 8)`.
- **Token.** `base64url(HMAC-SHA256(K, "${id}.${generation}.${salt}")).slice(0, 24)`. That is 24 URL-safe characters = **144 bits**. `salt` is 16 bytes from `crypto.randomBytes`, new on every issue and reissue.
- **Stored.** `tokenHash = sha256hex(token)`, `salt`, `generation` and `keyId`. The token itself is never stored, never logged and never put in an audit row. `AUDIT_REDACTED_KEYS` gains `salt`; `tokenHash` is already in it.
- **Link.** `${publicBaseUrl}/d/${token}`.
  - `publicBaseUrl` = AUTH_URL / NEXTAUTH_URL (the `password-reset.ts` helper).
  - Without them it is the origin of the request (the dispatcher's own host).
- **Where the token travels.** Only the QR landing page has it in its path (`GET /d/<t>`, a shell with no data, §6.1). The page reads it from its own URL and sends it on every API call as the header `Authorization: DriverLink <t>` to token-free paths (`/api/d/manifest`, `/api/d/actions`, `/api/d/photos`, `/api/d/photos/<id>`). Photos are fetched into blob URLs. So the token reaches server and proxy logs once per page open, not on every poll.
- **Lookup** (`resolveDriverLink`, used only by `withDriverLink`):
  1. A shape check `^[A-Za-z0-9_-]{24}$` (404 with no database work otherwise).
  2. `h = sha256(t)`, then `DriverLink.findFirst({ where: { OR: [{ tokenHash: h }, { prevTokenHash: h }] } })` (both columns are unique). This is the only lookup that is not tenant-scoped: a unique hash cannot cross tenants.
  3. Then the checks in §4.3.
- **Key rotation.** `resolve` compares `link.keyId` with the current `keyId`: a mismatch answers 410 `LINK_REPLACED` (never counted as a bad token). `ensure()` always re-derives the token, and when the key changed it writes the new `tokenHash` and `keyId`, so the link works again with a new token once the dispatcher reopens the dialog or reprints. Every old link therefore stops working at once after a rotation, which is the right outcome after a credential exposure. No start-up rehash is needed. This is documented in the handbook 2.9 and in admin.md.

### 4.2 Expiry

`expiresAt = zonedDayStart(addDaysIso(date, 1), tz) + 12 h`, where `tz` = `TenantConfig.timezone` (Asia/Muscat: 08:00 UTC on the next day). It is pure (`linkExpiry(date, tz)`) and tested across a month end.

**Upload-only grace: `uploadUntil = expiresAt + 72 h`** (pure `linkUploadUntil`). Between `expiresAt` and `uploadUntil`:
- GET manifest answers 410 `LINK_EXPIRED` with `uploadOnly: true`, so the page shows "This link has expired" and only flushes its queue;
- POST actions and photos are accepted only when every action's corrected `at` (a photo's `takenAt`) is `<= expiresAt`, and every event stored this way is flagged `late` (§8.3);
- after `uploadUntil`, everything answers 410 `UPLOAD_CLOSED`, and the page deletes its local data for that truck-day (§13.1).

72 h covers a weekend without data credit. A reissue keeps `expiresAt`, so it never extends either window.

### 4.3 States and transitions (lib/driver-link/service.ts)

| Action | Who | Effect | Audit |
|---|---|---|---|
| `ensureLink(runId, truckId)` | PLANNER+ (plan screen "Driver link", the dialog's WhatsApp, PDF) | Get or create the truck-day link. It first takes `pg_advisory_xact_lock(hashtextextended('driver-link:<tenant>\|<truck>\|<date>', 0))`, then reads and creates, so two callers never race into a P2002 inside one transaction (§13.3). Refused with 409 `LINK_DAY_OVER` when `expiresAt <= now`. A revoked link stays revoked: ensure returns it as revoked **without a token**, with "Reissue" offered. On a key change it rewrites `tokenHash` and `keyId` (§4.1). The truck must have at least one load on a live plan of that date. | `DRIVER_LINK_ISSUED` on creation only |
| `reissueLink(id, reason?)` | PLANNER+ | Under the same advisory lock: `prevTokenHash = tokenHash`, `generation + 1`, new `salt`, new `tokenHash`, `revokedAt = null`, `driverIdAtIssue` = the driver of the earliest load not COMPLETED, `devicesJson = null`, `issuedAt = now`. The old token answers 410 `LINK_REPLACED` at once (the one before it answers 404). | `DRIVER_LINK_REISSUED` {generation, reason, driverName} |
| `revokeLink(id, reason?)` | PLANNER+ | `revokedAt = now`. No token works until a reissue. | `DRIVER_LINK_REVOKED` |
| resolve (every driver request) | token | 404 `LINK_NOT_FOUND` (unknown hash, or the tenant is inactive); 410 `LINK_REPLACED` (the hash is `prevTokenHash`, or `keyId` differs); 410 `LINK_REVOKED`; 410 `LINK_EXPIRED` (with `uploadOnly` inside the grace); 410 `UPLOAD_CLOSED`. Otherwise it gives the context: tenantId, truckId, date, link, mode (`full` or `uploadOnly`). `lastSeenAt` and `devicesJson` are written at most every 5 min. | none (reads) |

**Which loads belong to a truck-day.**
1. Take the live plans of that date (the `currentPlan` rule: not SUPERSEDED or ARCHIVED, `supersededAt` null, the newest version per depot) that hold a load of the truck. Normally that is one depot.
2. Take every load of the truck on them, ordered by `departMin`.

While a re-plan runs, the live plan is the OPTIMIZING version. Its loads are copies (F2), so the page keeps working.

**Different drivers on one truck-day** (F6). The link still covers every load. The plan screen shows: "T05 has more than one driver today: the one link covers all its trips. Whoever holds it records for the truck."

**Driver changed after the link was issued** (D11). Pure `reissuePrompt(link, loads, changedLoadId, newDriverId)` decides. After a successful driver change, the plan screen asks only when **all** of these hold:
1. `driverIdAtIssue` is not null and differs from the new driver;
2. the changed load is the earliest load of the truck-day that is not COMPLETED;
3. no DISPATCHED load of the truck-day has a driver other than the new one (someone on the road holds the link).

When `driverIdAtIssue` is null (a link issued, or a pack printed, before any driver was chosen: the usual case for a hired truck or a daily driver), the new driver is recorded in `driverIdAtIssue` silently and nothing is asked. In every other case nothing is asked either. The prompt is:

> "The driver link for T05 on 5 Oct was made for Salim. Reissue it for Khalid? Printed sheets and WhatsApp messages already sent for T05 stop working: print or send again."
> [Keep link] (default) [Reissue link]

The **Reissue** button in the dialog stays available at any time (a leaked QR must be stoppable at once). While a DISPATCHED load of the truck-day has a driver, it asks first: "T05 L1 is on the road with Salim. His page stops working until he gets the new link: send it to him straight after." **Revoke** never asks.

**Used on more than one phone.** The dialog shows "Used on N phones (last 09:40)" from `devicesJson`. When N > 1 it adds: "If one of them is not the driver's phone, reissue the link."

## 5. API routes

All answers use the existing shape `{ data, error }`. Driver routes are wrapped in **`withDriverLink(handler, opts)`** (lib/driver-link/guard.ts). The wrapper:
1. reads the token from `Authorization: DriverLink <t>` and checks its shape (404 with no database work otherwise);
2. **resolves first** (one unique-index lookup, §4.1). A token that resolves, even to a 410, is **never** throttled by IP;
3. only an **unknown** hash (404) is counted, in `dl-bad:<ip>` (30 per 10 min). The counter is skipped when `clientIp` returns null or an internal address (the existing `INTERNAL_IP` ranges, now exported from client-ip.ts as `isInternalIp`), as sign-in does. When the counter is over its limit, unknown tokens from that IP get 429; known tokens still pass;
4. applies the per-link rate limits (§16.2). Every 429 carries `Retry-After` (seconds);
5. reads the session with `auth()`. Without a session the writer is the driver link. With a session of the link's tenant, the request is the office: reads are allowed; writes need PLANNER or above (else 403 `SIGNED_IN_READ_ONLY`) and are stored with the `userId`, results, Back at depot and manual arrivals with `source: DISPATCHER`, automatic arrivals and departures as PHONE_AUTO (the phone still measured them). A session of another tenant gets 403 `SIGNED_IN_OTHER_TENANT`;
6. reads `X-Driver-Device` (the page's random per-browser id, 32 hex; any other value is ignored) and `clientIp`;
7. builds the context `{ link, mode, tenantId, truckId, date, db: tenantDb(tenantId), ip, deviceId, session, actor }` (§16.4 for `actor`);
8. in `uploadOnly` mode, only POST actions and photos reach the handler (§4.2);
9. maps `HttpError` and Zod errors like `handleError`;
10. adds `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow, noarchive` to every answer.

`tests/lib/api-role-matrix.ts` classifies a handler containing `withDriverLink(` as **DRIVER_LINK**.

| # | Method and path | Guard | Body / query | Checks | Answers | Part |
|---|---|---|---|---|---|---|
| 1 | GET `/api/d/manifest` | DRIVER_LINK (60/min/link) | none | the truck-day only | 200 `DriverManifest` (§6.2); 410 with `uploadOnly` in the grace | 1 |
| 2 | POST `/api/d/actions` | DRIVER_LINK (60/min/link) | `{ clientNow, actions[≤50] }` (§8.1), ≤ 64 KB | each stop must be on a load of this truck-day, on a live plan, with the rules of §8.3 | 200 `{ results[], stops[] }`; 400 bad body; 409 `PLAN_BUSY` (lock timeout: the client retries) | 2 |
| 3 | POST `/api/d/photos` | DRIVER_LINK (per day: 3 × the truck-day's stops + 10; bursts 60 per 10 min) | multipart: `meta` (JSON) + `file`; `Content-Length` required (411), ≤ 1,600,000 (413) | JPEG by magic bytes (415); ≤ 3 driver photos per stop (409 `PHOTO_LIMIT`); stop rules as in #2 | 200 `{ photoId, status: 'ok' or 'duplicate' }` | 2 |
| 4 | GET `/api/d/photos/[photoId]` | DRIVER_LINK (120/min/link) | none | the photo's visit is on this truck-day | `image/jpeg`; 404 when purged or not found | 2 |
| 5 | GET `/api/dispatch/driver-links?runId=` | PLANNER | none | the run belongs to the tenant | the plan's truck-day links, loaded with the plan: `{ truckId, linkId, url (null when revoked or expired), qr: {size, d} or null, expiresAt, generation, revoked, expired, driverIdAtIssue, devices: { n, lastAt }, lastSeenAt, driversOnTruck[] }` (existing links only) | 1 |
| 6 | POST `/api/dispatch/driver-links` | PLANNER | `{ runId, truckId }` | the truck has a load on that plan | the link as in #5; 409 `LINK_DAY_OVER` | 1 |
| 7 | PATCH `/api/dispatch/driver-links/[id]` | PLANNER | `{ action: 'REISSUE' or 'REVOKE', reason? }` | the link belongs to the tenant | the link | 1 |
| 8 | POST `/api/dispatch/casual-driver` | PLANNER | `{ runId, loadId, name, phone?, useExisting?: driverId }` | the load can be edited (not on the road), as `setDriverTx` | `{ driver, load, reused: boolean }`; 409 `PHONE_BELONGS_TO` `{ driverId, name }` (§14) | 1 |
| 9 | GET `/api/runs/[id]/outcomes` | ANY | none | the run belongs to the tenant | the outcome overlay of this version's DISPATCHED and COMPLETED loads (§10.1) | 3 |
| 10 | POST `/api/dispatch/outcomes` | PLANNER | `{ key, depotId, date, truckId, loadNo, sequence, outcome or null, reason?, note?, lines?, arrivedAt?, departedAt?, undoCarry?: boolean }` | as in #2, plus any ON_ROAD load, plus the carried check (§9.4) | `{ result, visit, carryUndone? }`; 409 `OUTCOME_CARRIED` `{ copyId, copyDate, undoable }`; 422 invalid | 3 |
| 11 | GET `/api/delivery-photos/[id]` | ANY | none | tenantDb | `image/jpeg`; 404 `PHOTO_PURGED` (JSON) | 3 |
| 12 | GET `/api/dispatch/delivery-actuals?from&to&depotId?` | PLANNER | a range of 31 days or less | none | xlsx (§11.3) | 3 |
| 13 | GET `/api/customers/delivery-stats?ids=` | ANY | ≤ 200 ids | tenantDb | `{ [customerId]: MeasuredUnloading }` (§11.1) | 3 |
| 14 | GET `/api/customers/pin-check` | TENANT_ADMIN | none | none | the list of §11.2 | 3 |
| 15 | POST `/api/dispatch/carry-over/undo` | PLANNER | `{ originalOrderId }` | §9.4 | `{ undone: true, replanNeeded: false }`; 409 `COPY_PLANNED` / `COPY_ON_ROAD` / `PLAN_BUSY` | 3 |

Existing routes extended, with their roles unchanged:
- `GET /api/runs/[id]/export/pdf`: prints the driver-link QR for PLANNER+ only (§6.6).
- `PATCH /api/runs/[id]/loads/[loadId]`: rule 20 (§14).
- `GET /api/dispatch/day`: a `deliveries` block (§11.4).
- `GET /api/dashboard/kpis`: outcome KPIs.
- `GET|POST /api/dispatch/carry-over`: outcomes (§9).
- `GET|PATCH /api/tenant/config`: five admin settings (geofence radius, photo proof required, photo retention, location retention, dispatcher phone).
- `POST|PATCH /api/trucks`: `hired`.
- `PATCH /api/drivers/[id]`: `casual` (admin).
- The janitor (`/api/cron/janitor` and the loop): returned-load completion (Part 2); photo purge, location purge and the daily-driver clean-up (Part 3).

New route files: **14**.
- Part 1: 4 (#1, #5/#6 are one file, #7, #8).
- Part 2: 3 (#2, #3, #4).
- Part 3: 7 (#9 to #15).

None of the driver API paths carries the token. `tests/lib/repo-guards.spec.ts` asserts that no folder under `app/api/d` is a dynamic `[token]` segment.

## 6. The driver page

### 6.1 Surface

- `app/d/[token]/layout.tsx` sets its own metadata (`robots: noindex, nofollow`; `referrer: no-referrer`; the generic title "RouteIQ - driver page", no description and no Open Graph tags) and a minimal frame: no tenant navigation.
- `app/d/[token]/page.tsx` is a **shell**: it renders the client app and nothing else. It never reads the database, never resolves the token and never puts customer data in the HTML, so a link previewer that fetches a forwarded link gets an empty page, and the page route needs no throttle. The client reads the token from its URL, fetches the manifest (#1) and shows the link states (404 / 410) from that answer. `tests/lib/repo-guards.spec.ts` asserts that nothing under `app/d/**` imports `@/lib/db`, `@prisma/client` or `lib/driver-link/service`.
- The edge middleware needs no change: it only protects `/t/` and `/admin`.
- `next.config.js` adds a header rule for `/d/:path*` and `/api/d/:path*`, placed **after** the global rule (in Next, the last matching rule wins per key):
  - `Referrer-Policy: no-referrer`
  - `X-Robots-Tag: noindex, nofollow, noarchive`
  - `Cache-Control: no-store`
  - `Permissions-Policy: geolocation=(self), camera=(self)`
- Every outbound link (Google Maps) carries `rel="noreferrer noopener"`.
- The page registers the driver service worker (§13.4) with scope `/d/`.

**In-app browsers (`webview-gate.tsx`, Part 1).** Casual and hired-truck drivers often scan with a QR app or Google Lens, or tap the link inside Facebook, Instagram or Snapchat. Those in-app browsers often refuse location without asking, ignore the camera input and keep their own storage. On load, the page detects one:
- by the user agent: the Android WebView token `; wv)`, or `FBAN`, `FBAV`, `Instagram`, `Line/`, `Snapchat`;
- or by a failure: geolocation `PERMISSION_DENIED` with no prompt ever shown (the Permissions API still says `prompt`), or the file chooser not opening within about 3 s of the tap on Take photo.

It then shows a full-width card at the top:
- Android: **[Open in Chrome]**, a link to `intent://<host>/d/<token>#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=<url-encoded link>;end`;
- iOS: "Tap ⋯ or the share icon, then Open in Safari" with **[Copy link]**.

The page still works read-only inside the in-app browser. The PDF caption says "Scan with the phone camera - opens in Chrome/Safari" (§6.6).

**Targets.** Android 8+ Chrome and iOS 15+ Safari. The page must work at 360 × 640.
- Touch targets ≥ 48 px, body text ≥ 16 px, high contrast, a lucide icon next to each word.
- No map library. The page JavaScript stays under about 150 KB gzipped.
- Inter covers Latin text. Arabic falls back to the phone's system font.

**Language.** EN and AR, chosen in this order:
1. `localStorage riq.d.lang` (wrapped in try/catch);
2. else `navigator.language` starting with `ar`;
3. else EN.

The toggle sits in the header. AR sets `dir="rtl" lang="ar"` on the page root. Times are 24 h `HH:MM`. Digits are Western in both languages (`Intl` with `ar-OM-u-nu-latn`). Customer names, addresses and notes are data: they are shown as they are, with `dir="auto"`.

### 6.2 Manifest (GET /api/d/manifest, Part 1; results merged in Part 2)

`lib/driver-link/manifest.ts` is a **projection of `getPlanDetail`** for the truck's loads. It is the same source as the PDF, so stops, cases, split labels, promised times and notes cannot drift.
- It is memoised per `runId` for up to 60 s in process memory, under a stamp (load count, max `statusChangedAt`, max `driverSetAt`) read on every request. A dispatch or a driver change therefore shows at once.
- Outcome state is read live, never memoised.
- It **never** carries money (cost, fuel, sales, margin, payment amounts), priorities, other trucks or other customers.

```ts
interface DriverManifest {
  date: string; tz: string; serverNow: string; tenantName: string;
  link: { expiresAt: string; uploadUntil: string; generation: number };
  truck: { code: string; hired: boolean };
  drivers: { name: string; casual: boolean }[];          // distinct drivers of the truck-day's loads
  depot: { code: string; name: string; lat: number; lng: number };
  settings: { radiusM: number; photoRequired: boolean; maxPhotos: 3; locationRetentionDays: number;
              dispatcherPhone: string | null };            // "Call dispatcher" (hidden when null)
  office: { userName: string } | null;                    // set when a signed-in RouteIQ user opened the page (§5 step 5)
  loads: {
    loadNo: number; trips: number; status: LoadStatusName; actionable: boolean; // DISPATCHED only
    departMin: number; returnMin: number; driverName: string | null; cases: number;
    backAtDepotAt: string | null;                         // Part 2
    stops: {
      key: string;                                        // `${loadNo}:${sequence}`
      sequence: number; customerName: string; customerCode: string; branchCode: string | null;
      address: string | null; lat: number; lng: number; navUrl: string;
      etaMin: number | null; untilMin: number | null;
      hours: { hardStart: number | null; hardEnd: number | null; prefStart: number | null; prefEnd: number | null } | null;
      promised: { startMin: number | null; endMin: number | null } | null;
      cases: number;
      orders: { orderId: string; salesOrders: string[]; lines: { lineId: string; productCode: string; productName: string; cases: number }[] }[];
      notes: string[]; accessNotes: string | null;
      split: { part: number; parts: number } | null; carriedFrom: string | null;
      result: StopResult | null;                          // Part 2 (§8.6)
    }[];
  }[];
}
```

This needs two **additive** fields on `DetailStop` (plan-detail.ts, Part 1):
- `orderLines: { orderId, lineId, salesOrderNo, productCode, productName, cases }[]`, built from the row lines (`rowLinesKg`) with no aggregation. Partly-delivered entry (Part 2) needs the `lineId`s.
- `plannedHours: { hardStart, hardEnd, prefStart, prefEnd } | null` and `promisedWindow: { startMin, endMin } | null`, the structured version of the `window` / `promised` strings. The page formats them per language, and the KPIs use them.

The Excel workbook and the PDF ignore both fields.

The page keeps the last manifest it received in IndexedDB (namespace `${truckId}|${date}`, §13.1) and renders from it when a fetch fails, with "Last updated 10:12" in the header.

`navUrl` is `https://www.google.com/maps/dir/?api=1&destination=<lat,lng>&travelmode=driving`, using the **planned pin** (snapshot). That is the same pin as the sheet; a pin moved since planning shows as a note, exactly like the sheet's "New pin - ask the dispatcher".

### 6.3 Screens and states

| Screen / state | What the driver sees | EN key text | Part |
|---|---|---|---|
| **Header** (always) | date, truck code (+ "Hired truck"), driver name, language toggle, sync chip; "Last updated 10:12" when showing the stored manifest | "Sun 5 Oct · Truck T05 · Salim" · chip "All sent ✓" / "Waiting to send (3)" / "No signal" | 1 (chip: 2) |
| **Office banner** (a signed-in RouteIQ user opened the page) | yellow banner | "You are signed in to RouteIQ as Ali: results are recorded as the office." | 1 |
| **In-app browser card** (§6.1) | full-width card at the top | "Open in Chrome" / "Open in Safari: tap ⋯ then Open in Safari" + [Copy link] | 1 |
| **Location notice** (first open, then from an ⓘ icon) | the text of §16.3, with [OK] | | 1 |
| **Trips list** | one card per load, in departure order: "Trip 1 of 2 · Depart 07:10 · 9 stops · 412 cases" and a status chip | PLANNED "Planned - may still change" · LOCKED "Not loaded yet" · LOADING "Loading" · DISPATCHED "On the road" · COMPLETED "Done" | 1 |
| **Stops list** (the current trip open, §7.3; others collapsed; only DISPATCHED loads take results) | rows: sequence badge, customer + branch, ETA, promised or hours, cases, result chip | chips: "Next", "Arrived · 12 min", "Delivered", "Partly", "Not delivered", "No result", "Saved on phone - waiting to send", "Changed by office / another phone" | 1 (chips: 2) |
| **Stop sheet** | big **Navigate** button with the hint under it "When you arrive, open this page again"; ETA "Planned 10:15 · unload until 10:40"; hours or "Promised 10:00-11:00"; per order: sales order(s), then product code, name and cases; notes; access notes; split "Part 1 of 2"; "Carried over from 3 Oct" | | 1 |
| Stop sheet: timer area | before arrival: "Waiting to arrive (within 100 m)" + [I have arrived]; at the stop: "Arrived 10:02 · Unloading 12:34" (wake lock on); after the result: "Done 10:31 · 29 min" | | 2 |
| Stop sheet: "Arrived at ACME - when?" | shown when the page comes back (visible again) at a pending stop whose arrival was not observed (§7.3): chips **Now · 5 min ago · 10 min ago · 15 min ago** and [Skip]. A chip records a PHONE_MANUAL arrival at that time. | "Arrived at {customer} - when?" | 2 |
| "Which customer?" | two or more pending stops are inside the radius together (§7.3): one chip per customer; the chosen stop gets the automatic arrival time | "Which customer are you at?" | 2 |
| Stop sheet: actions | three big buttons: **Delivered ✓** · **Partly** · **Not delivered ✗**; after a result: the result, photo thumbnails, [Change result] (until the load is COMPLETED, and never once the order was brought forward: `editable` false) | | 2 |
| **Delivered flow** | [Take photo] (camera) → preview [Use photo] / [Retake] → up to 3 → [Save]. With "photo required", Save stays disabled until one photo exists. Under Take photo, a small link **"Camera not working"** saves without a photo (`noPhotoReason: CAMERA_FAILED`, §8.2). A thumbnail without a position shows "Location not captured: take it again at the shop if you can". | "Photo required" | 2 |
| **Partly flow** | per order line, a stepper (− / number / +), default = all, range 0..planned → reason (big list, §8.2) → note (required for Other) → photo (required, with the same "Camera not working" link) → [Save] | "Cases delivered" | 2 |
| **Not delivered flow** | reason list → note (required for Other) → photo (optional) → [Save] | | 2 |
| **Draft restored** | the page was reloaded while a result was being entered (for example the phone closed the tab while the camera was open): the stop sheet reopens with the draft (§13.1) | "Your last entry was kept. The last photo did not arrive - take it again." | 2 |
| **Back at depot** | after the last stop of a load: a big button. Also always under the stop list, with the confirm "3 stops have no result. The dispatcher will record them." The page also suggests it when the truck has been at the depot for 2 min after the trip's stops (§7.3). | "Back at depot" | 2 |
| **Not dispatched yet** | a load that is LOCKED or LOADING: no result buttons. **Start deliveries** is still offered from 30 min before its planned departure, so arrival times are kept on the phone (§7.3). A big **Call dispatcher** button (`tel:` the `dispatcherPhone` setting; hidden when empty). | "Your dispatcher has not marked this trip as left yet. Arrival times are kept on the phone and sent once it is. Results can be recorded then." | 1 (held timing: 2) |
| **Location off / denied** | banner | "Location is off: the timer cannot start by itself. Tap 'I have arrived' at each customer." | 2 |
| **No trips** | | "No trips for truck T05 on 5 Oct (yet)." | 1 |
| **Link not working** (404 / revoked) | full page | "This link does not work any more. Ask your dispatcher for a new one." | 1 |
| **Link replaced** (410 `LINK_REPLACED`) | full page; when results are still waiting on this phone, they are listed (stop, result, time) so the dispatcher can enter them | "This link was replaced by a new one. Ask your dispatcher for it. Not sent from this phone: {n} - show this list to your dispatcher." | 1 (list: 2) |
| **Link expired** | full page; inside the upload grace the queue keeps sending, with its chip | "This link was for 5 Oct and has expired." (+ "Sending the results saved on this phone…") | 1 (grace: 2) |
| **Busy / error** | toast; the action stays queued | "Not sent yet - it will be sent automatically." | 2 |

Refresh rules:
- The page polls GET #1 every 60 s while visible, on `online`, and after each batch is sent. The answer of #2 already carries the updated stops.
- **After a 404 or a 410 the page stops polling and stops every retry**, except the queue flush in the upload-only grace (§4.2). It then clears the service-worker cache and, after `UPLOAD_CLOSED`, its stored data for that truck-day (§13.1).
- A **Start deliveries** button (a user gesture: iOS prompts for location only after one) starts `watchPosition` and the wake-lock logic. It is shown when tracking is off and the truck-day has a load that is not COMPLETED and whose planned departure is at most 30 min away (or past).
- **Restart without a tap.** On load, when `navigator.permissions.query({ name: 'geolocation' })` answers `granted`, tracking restarts by itself if it was on before the reload (a flag in the namespace). The button is shown only for `prompt`, or when the Permissions API is missing.
- **Rebuild after a reload.** The tracker starts from the server's `StopResult` (`state: 'ARRIVED'` with its `arrivedAt`) and from unsent local ARRIVE items, so a stop in progress comes back as AT_STOP with its original arrival time and the timer keeps counting (§7.3).

### 6.4 i18n

`lib/driver-page/i18n.ts` is pure and browser-safe. It exports `DICT: Record<'en' | 'ar', Record<Key, string>>`, plus `t(lang, key, vars)` and the formatters `fmtDate(lang)`, `fmtHours(lang, hours, promised)` and `reasonLabel(lang, reason)`.
- Placeholders are written `{n}`.
- To avoid Arabic plural forms, texts use "label: value" ("المحطات: 9"), never "9 stops" built from parts.

Appendix A has the Arabic strings. An NMWC Arabic speaker must review them (Q2).

### 6.5 Plan screen: "Driver link" (Part 1)

In `LoadDriver` (plan-view.tsx:1158), next to PDF and WhatsApp, a **Link** action opens `driver-link-dialog.tsx`. The dialog shows:
- the QR code (the SVG path comes from the server, `qr` in #5/#6, so `qrcode` stays out of the browser bundle);
- the link with [Copy];
- [WhatsApp]: `wa.me` to the driver's number, with "RouteIQ - your trips for Sun 5 Oct, truck T05: <link>" in EN and AR;
- the expiry ("Works until 6 Oct 12:00");
- "Last opened 07:15 · Used on 1 phone" (from `lastSeenAt` and `devicesJson`, §4.3);
- [Reissue link] and [Revoke].

When no link exists, opening the dialog calls POST #6 (ensure).

**Links load with the plan.** For PLANNER+, the plan screen calls GET #5 together with the plan detail and again after a reissue or revoke. GET #5 never creates a link and writes no audit row.

The per-load **WhatsApp** message gets a line after its header: "Your trips and delivery results: <link>". `whatsappText(plan, load, trips, { tenantName, driverLinkUrl })` gains the optional field. The `wa.me` href is still built **synchronously at render**, as today (plan-view.tsx:898), so the click opens WhatsApp without an awaited call that a browser would block as a pop-up:
- the truck-day has an active link (from #5): the href carries the line;
- the truck-day has no link yet: the WhatsApp action opens the Driver link dialog instead, which ensures the link and offers [WhatsApp] from there;
- the link is revoked or expired: the message is sent without the line, and the dialog says why;
- a VIEWER (no #5): the message as today, without the line.

**Late dispatch flag** (§7.3). When a truck-day's link was opened (`lastSeenAt`) after a load's planned departure and that load is still LOCKED or LOADING, the Loads table shows an amber note: "T05 L1: driver page opened 07:15, load still Loading - planned departure 07:10. Dispatch it if it has left." The day screen lists the same notes. This uses `lastSeenAt` only: no new location data.

Superseded versions and running optimizations keep their current "off" reasons.

### 6.6 PDF driver sheets (Part 1)

- `qrPath` moves to `lib/dispatch/qr.ts`. `driver-pack.tsx` imports it from there.
- `DriverPackOptions` gains `driverLinks?: ReadonlyMap<truckId, string>`.
- `SheetPage` prints the driver-link QR **first**: 76 pt, caption "Scan with the phone camera - opens in Chrome/Safari" (the PDF font is Latin only). Then at most **2** route QR codes at 64 pt. Route parts beyond 2 stay as the text links already printed.
- The export route calls `ensureLink` for each truck-day in the pack **only when `hasRole(user.role, 'PLANNER')`**. A VIEWER's PDF prints "Driver link: ask the dispatcher" in that place.
- Each truck-day's ensure runs in its own transaction. A failure for one truck (plan busy, lock timeout) prints the placeholder "Driver link: ask the dispatcher" on that truck's sheets and never fails the pack.
- A **revoked** link prints "Driver link stopped - ask the dispatcher" and no QR (ensure returns no token for it). Truck-days whose link is past its expiry print nothing.

## 7. The automatic stop timer (pure functions)

### 7.1 Parameters

`lib/delivery/geofence.ts` is pure and browser-safe. Its only import is `distanceM` from `lib/dispatch/snapshots.ts`, whose imports are types and `order-window` (both pure). It is unit-tested with synthetic tracks.

```ts
export interface GeofenceParams {
  radiusM: number;        // TenantConfig.geofenceRadiusM (default 100, clamped 50..500)
  exitExtraM: number;     // 50: departure needs radius + 50 m
  arriveDwellMs: number;  // 20_000: for the expected stop (the first stop of the current trip without a result)
  otherDwellMs: number;   // 90_000: for any other pending stop (a wait at a roundabout is not an arrival)
  departDwellMs: number;  // 60_000
  maxAccuracyM: number;   // 250: a worse fix is ignored
  maxFixAgeMs: number;    // 30_000: an older fix cannot confirm anything; a longer silence is a gap
  movingMps: number;      // 2.5 (9 km/h): a faster fix is never "at the stop"
  depotDwellMs: number;   // 120_000: at the depot this long after the trip's stops -> suggest "Back at depot"
}
export interface Fix {
  at: number;             // Date.now() read inside the watchPosition callback: the device clock (§13.3)
  gpsAt: number | null;   // position.timestamp: diagnostics only, never read by a rule (some Android
                          // phones fill it from the GNSS clock, which can differ from the device clock)
  lat: number; lng: number; accuracyM: number; speedMps: number | null;
}
export interface TrackStop {
  key: string; loadNo: number; sequence: number; lat: number; lng: number;
  doneAt: number | null;  // the result time (server, or a queued local result: applyQueued, §13.5)
  expected: boolean;      // the first stop of the current trip without a result, in sequence
  nearDepot: boolean;     // pin within radiusM + exitExtraM of the depot pin: manual arrival only
}
export interface TrackInput { now: number; fix: Fix | null; visible: boolean; stops: TrackStop[]; depot: { lat: number; lng: number } }
```

Every time the page sends (`at`, `pos.at`, a photo's `takenAt`) is on the device clock, so the server's single skew correction (§13.3) applies once.

### 7.2 Zone of one fix

```
allowance = min(fix.accuracyM, radiusM / 2)          // accuracy-aware, but bounded
d = distanceM(fix, stop)
IGNORED if fix.accuracyM > maxAccuracyM
IN      if d <= radiusM + allowance and not (fix.speedMps != null and fix.speedMps > movingMps)
OUT     if d - allowance > radiusM + exitExtraM
NEAR    otherwise                                      // neither confirms nor breaks a departure
```

### 7.3 Tracker state machine

**Why the page cannot see everything.** Browsers deliver positions only while the page is visible. The driver leaves the page for Maps (Navigate) and for the camera, and the screen locks between stops. So the tracker must tell an arrival it **saw** (the truck was seen outside, then inside) from one it only **found** when the page came back (the first fix was already inside). Only seen arrivals and departures are "observed" and feed measured times and the on-time KPI (§8.4, §11). True arrival times for every stop come with Ayun later (§17).

**The current trip** (pure `currentTrip(manifest, local)`, Part 2). Only its stops are candidates:
1. the DISPATCHED load with the **highest** load number that has no BACK_AT_DEPOT event (on the server or queued on the phone). Once a later trip is dispatched, the earlier trip's stops without a result drop out of automatic timing (they still take a manual arrival and a result);
2. else, when the driver tapped Start deliveries, the earliest LOCKED or LOADING load whose planned departure is at most 30 min away or past. Its events are **held** on the phone and sent once the manifest shows the load DISPATCHED (§13.2), so a late Dispatch click loses no timing;
3. else none: the tracker is idle.

Stops with `nearDepot` (pin within `radiusM + exitExtraM` of the depot pin) never arrive automatically: a truck standing at the depot would arrive there. They take "I have arrived".

The function is `step(state, input, params) → { state, events, prompts }`. The hook calls it on every fix, on a 5-second tick, and on every `visibilitychange` (with `visible`).

```
TrackerState = common & (SEEKING | AT_STOP)
  common  = { lastFixAt: number | null,
              gap: boolean,                       // set when visible == false, or when now - lastFixAt > maxFixAgeMs;
                                                  // cleared once the next current fix has been handled
              seenOutside: { [key]: number } }    // the last fix time at which a pending stop of the trip was NOT IN
  SEEKING = { phase: 'SEEKING', cand: { key, since, observed } | null, ambiguous: { keys, since } | null }
  AT_STOP = { phase: 'AT_STOP', key, arrivedAt, observed, lastInAt,
              leaving: { since } | null, next: { key, since } | null,
              cleanSince: number | null,          // fixes continuous (no gap) since then; null right after a gap
              outSinceDone: boolean }             // an OUT fix for this stop after its result

current(fix) = fix != null and now - fix.at <= maxFixAgeMs
cands        = stops with doneAt == null and not nearDepot
observedAt(key, t) = seenOutside[key] exists and t - seenOutside[key] <= maxFixAgeMs and no gap since seenOutside[key]

SEEKING (on a current fix):
  for s in cands with zone(fix, s) != IN:  seenOutside[s.key] = fix.at
  IN = cands with zone(fix, s) == IN
  if IN.length >= 2:                       // two shops in one building, or two branches at one pin
      ambiguous ??= { keys: IN.keys, since: fix.at }; cand = null
      prompt "Which customer?"; on the driver's choice k:
          emit ARRIVED(k, at = ambiguous.since, observed = observedAt(k, ambiguous.since), chosen = true)  -> AT_STOP(k)
      return
  ambiguous = null
  s = IN[0] or null
  if s == null:                cand = null
  elif cand?.key != s.key:     cand = { key: s.key, since: fix.at, observed: observedAt(s.key, fix.at) }
  dwell = s.expected ? arriveDwellMs : otherDwellMs
  if cand and now - cand.since >= dwell:
      emit ARRIVED(cand.key, at = cand.since, observed = cand.observed, resumed = !cand.observed)
      -> AT_STOP(key, arrivedAt = cand.since, observed = cand.observed, lastInAt = fix.at, cleanSince = fix.at)
      if not cand.observed and visible: prompt "Arrived at {customer} - when?" (§6.3)

AT_STOP(key):
  on a gap (page hidden, or no current fix for maxFixAgeMs):  cleanSince = null
  on a current fix:
    z = zone(fix, stop(key))
    if z == IN:   leaving = null; lastInAt = fix.at
    if z == OUT and stop(key).doneAt != null and fix.at > stop(key).doneAt:  outSinceDone = true
    if z == OUT and cleanSince == null:
        // The first fix after a gap is already outside: the departure was not seen.
        emit DEPARTED(key, at = lastInAt, reason 'LEFT', gap = true)  -> SEEKING (and run SEEKING on this fix)
        return
    if cleanSince == null:  cleanSince = fix.at
    if z == OUT:  leaving ??= { since: fix.at }
    // (NEAR or IGNORED: no change)
    if leaving and now - leaving.since >= departDwellMs and z != IN:
        emit DEPARTED(key, at = leaving.since, reason 'LEFT')  -> SEEKING
    // Neighbour shops (a mall): only when the truck demonstrably did not move.
    if stop(key).doneAt != null and z != OUT and not outSinceDone
       and cleanSince != null and cleanSince <= stop(key).doneAt:      // no gap since the result
        b = the cand (not key) that is IN and whose pin is within radiusM + exitExtraM of stop(key)'s pin
        next = b ? (next?.key == b.key ? next : { key: b.key, since: fix.at }) : null
        if next and now - next.since >= arriveDwellMs:
            emit DEPARTED(key, at = stop(key).doneAt, reason 'NEXT_STOP')
            emit ARRIVED(next.key, at = stop(key).doneAt, chained = true, observed = true)  -> AT_STOP(next.key)
```

Any other case after a gap takes the normal path: a departure at the last inside fix flagged `gap`, then SEEKING, with the next arrival at its first inside fix (`observed: false` when it was already inside on the first fix).

**Manual arrival.** "I have arrived" sets `AT_STOP(key, arrivedAt = now, observed = true)` and queues ARRIVE with `mode: 'MANUAL'`. The "when?" chips queue ARRIVE `mode: 'MANUAL'` with `at = now - n min`. Departure is still detected automatically.

**GPS lost.** With no fix, or only stale fixes, no transition happens; the gap is recorded. The server ends the stop at the result time (§8.4). The page says "GPS signal lost" after 90 s without a fix.

**Back at depot suggestion.** When the current trip has at least one stop with an arrival or a result and the truck has been IN the depot zone for `depotDwellMs`, the page shows "Back at depot?" with the big button. Nothing is recorded without the tap.

**Rebuild after a reload** (§6.3). `restoreTracker(manifest, queued)` returns AT_STOP for a stop whose server `StopResult.state` is ARRIVED, or that has an unsent local ARRIVE without a result, with its original `arrivedAt` and `observed`, and `cleanSince = null` (the reload was a gap).

**Wake lock.**
- `navigator.wakeLock.request('screen')` is called when the phase becomes AT_STOP, and again on `visibilitychange → visible` while AT_STOP.
- It is released on DEPARTED.
- An error or an unsupported browser is ignored.

The page must be honest about this. Under the timer it says "Keep this page open. If the screen locks, the timer may pause." Under Navigate it says "When you arrive, open this page again." The docs say the same.

**Privacy.** Fixes live only in the hook's memory (the latest one, plus the candidate starts and the `seenOutside` times). They are never queued, sent or stored, except the one position attached to an event (§16.3).

`watchPosition` options: `{ enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }`. The battery cost is documented: advise a car charger.

### 7.4 Required unit cases (tests/lib/geofence.spec.ts)

1. 25 s inside → ARRIVED at the first inside fix.
2. A 15 s drive-by → nothing.
3. Inside but at 4 m/s → nothing.
4. 300 m accuracy fixes → ignored.
5. d = 140 m with 60 m accuracy and R = 100 → IN (allowance 50). d = 160 m → NEAR.
6. After arrival: jitter between 120 and 160 m → no departure.
7. 70 s at 200 m → DEPARTED at the first OUT fix.
8. A single OUT fix then back IN → no departure.
9. GPS lost while at the stop → no events.
10. Two pending stops inside the radius together → no automatic arrival; the "Which customer?" prompt; the chosen stop gets the time of the first common inside fix.
11. Neighbour shops 40 m apart with continuous fixes after a result → DEPARTED(A, doneAt, NEXT_STOP) and ARRIVED(B, doneAt, chained).
12. A false arrival in traffic, departure, then the real arrival → two cycles (§8.4 picks the right one).
13. A fix older than 30 s never confirms.
14. A stop that already has a result is not picked again.
15. Hidden 25 min after a result at A (Maps in front), resumed at B 3 km away → DEPARTED(A, at the last inside fix, gap) and ARRIVED(B) at its first inside fix with `observed: false`; **no chained arrival**.
16. GPS lost 4 min (a tunnel) at A after its result, then an OUT fix → DEPARTED(A, gap); no chained arrival.
17. Neighbour pins 300 m apart (more than R + 50) → never chained, even with continuous fixes.
18. OUT fixes up to 10 s before the first inside fix → `observed: true`. The page opened already inside → `observed: false` and the "when?" prompt.
19. Trip 1 stop 7 without a result and trip 2 dispatched to the same customer → the arrival goes to trip 2's stop.
20. 25 s at a roundabout inside the radius of stop 9 while stop 3 is expected → nothing (90 s rule); stop 3 then arrives after 20 s.
21. A customer pin 120 m from the depot (R = 100) → never arrives automatically.
22. Fixes whose `gpsAt` is 5 min off the device clock still arrive (`at` is the callback's `Date.now()`).
23. Two minutes at the depot after the trip's stops → the "Back at depot?" prompt, no event.
24. `restoreTracker`: a server ARRIVED stop and an unsent local ARRIVE each come back as AT_STOP with their original `arrivedAt`.
25. `currentTrip`: a LOCKED load after Start → held mode; the highest DISPATCHED load wins over an earlier one with stops left.

## 8. Outcomes: rules, the visit and completion

### 8.1 Actions (POST #2)

```ts
type Pos = { lat: number; lng: number; accuracyM: number; at: string; gpsAt?: string | null; speedMps?: number | null };
type Action =
  | { key: string; type: 'ARRIVE'; stop: string; at: string; mode: 'AUTO' | 'MANUAL'; pos?: Pos;
      chained?: boolean; observed?: boolean /* default true */; chosen?: boolean /* "Which customer?" */ }
  | { key: string; type: 'DEPART'; stop: string; at: string; mode: 'AUTO'; pos?: Pos; reason: 'LEFT' | 'NEXT_STOP'; gap?: boolean }
  | { key: string; type: 'OUTCOME'; stop: string; at: string; pos?: Pos;
      outcome: 'DELIVERED' | 'PARTLY_DELIVERED' | 'NOT_DELIVERED' | null;   // null = Undo / clear the result
      reason?: NotDeliveredReason; note?: string; lines?: { lineId: string; delivered: number }[]; photoKeys: string[];
      noPhotoReason?: 'CAMERA_FAILED' }
  | { key: string; type: 'BACK_AT_DEPOT'; load: number; at: string; pos?: Pos };
// key: crypto.randomUUID() made on the phone when the action is created; it never changes on a retry.
// Only a lowercase UUID is accepted (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); the server
// stores it as "dl:<uuid>" (§13.3).
```

The answer has one result per action: `{ key, status: 'ok' | 'duplicate' | 'refused', code?, message?: { en, ar } }`.
- **Permanent refusals** are removed from the queue and shown: `STOP_NOT_FOUND`, `LOAD_COMPLETED`, `OUTCOME_CARRIED`, `PHOTO_REQUIRED`, `INVALID`, `TIME_OUT_OF_RANGE`, and `LOAD_NOT_DISPATCHED` for OUTCOME and BACK_AT_DEPOT.
- **Transient failures** stay queued: `LOAD_NOT_DISPATCHED` for ARRIVE and DEPART (kept until the load is DISPATCHED or the upload window ends: the server checks again then; the stops of a LOCKED or LOADING load are frozen, so the stop key is stable); the whole request answering 409 `PLAN_BUSY`, 429 (after `Retry-After`) or 5xx; a network error.

### 8.2 Validation (lib/delivery/outcome-rules.ts, pure)

| Rule | Detail |
|---|---|
| Lines | `lineId`s must belong to the stop's planned lines (`plannedStopOf`, §8.5). A line not sent defaults to all its cases (DELIVERED or PARTLY) or to 0 (NOT_DELIVERED). Each value is an integer in 0..planned. |
| DELIVERED | Every line is set to planned (any `lines` sent are ignored). No reason. |
| PARTLY_DELIVERED | After defaults, 0 < delivered < planned. If every line is full, the result is coerced to DELIVERED. If every line is 0 → 422 "Choose Not delivered". A **reason is required** for the missing cases (same list; §21 C2). |
| NOT_DELIVERED | Every line is 0. A reason is required. |
| OTHER | A note of 3 to 300 characters is required. Any other note is optional, up to 300 characters. |
| Photo | When `photoProofRequired` and the source is the driver: DELIVERED or PARTLY needs `photoKeys.length >= 1` (`PHOTO_REQUIRED`), **unless** `noPhotoReason: 'CAMERA_FAILED'` (the only exception: a broken camera or an in-app browser must never block a delivery). The photos themselves may arrive later (queue). The dispatcher's results are not held to it. The overlay, the day-end list and the actuals Excel show "no photo: camera failed (driver)" or "no photo (office)". |
| `null` result (Undo) | Allowed for the driver until the load is COMPLETED, and for the dispatcher at any time. Subject to the carried check. |
| Time | `at` is corrected and clamped (§13.3). Outside the day window → `TIME_OUT_OF_RANGE`. |

### 8.3 Who may write, and when

| Writer | Stop's load (live plan) | Allowed |
|---|---|---|
| Driver link | DISPATCHED | yes |
| Driver link | COMPLETED | **Gap-filling only.** Every action needs `at` < the load's `statusChangedAt` and must arrive inside the upload window (§4.2). An OUTCOME (including a clear) is accepted only when the stop had **no result at completion**: no OUTCOME event of that visit with `receivedAt <= statusChangedAt`. Later late results on such a stop may follow each other (an offline phone sends its changes in order). A stop that had a result at completion refuses any OUTCOME with `LOAD_COMPLETED`, whatever its `at`. ARRIVE, DEPART and PHOTO are accepted (they add timing or proof; they never change a result). Every event accepted this way is stored with `payload.late = true`. |
| Driver link | DISPATCHED, received after `expiresAt` (upload grace) | accepted as above when `at <= expiresAt`; stored with `payload.late = true` |
| Driver link | LOCKED, LOADING | ARRIVE and DEPART: `LOAD_NOT_DISPATCHED`, **transient** (the phone keeps them, §8.1). OUTCOME and BACK_AT_DEPOT: `LOAD_NOT_DISPATCHED` (refused) |
| Driver link | PLANNED | `LOAD_NOT_DISPATCHED` (refused) |
| Signed-in office user on the driver page (§5 step 5) | as Dispatcher | PLANNER+ only; stored with the `userId`; results, Back at depot and manual arrivals as `source: DISPATCHER` |
| Dispatcher (#10) | DISPATCHED or COMPLETED | yes, at any time. A correction is audited with before and after. |
| Any | an order of the stop was brought forward (`carriedToOrderId`) | the carry-basis rule of §9.4: a change that would **reduce** the cases already brought forward from a visit in the basis is refused `OUTCOME_CARRIED` (photos can still be added; the dispatcher is offered "Undo bring forward"). Any other change is stored. |

`StopVisit.outcomeLate` is true when the event that set the current result has `payload.late`. Such a result shows "recorded after the trip closed" in the overlay and is **never ticked by default** in Bring forward (§9.1).

Every write runs in **one short transaction per action**, in this order:
1. `setLockTimeout(5 s)`.
2. Resolve the live load `(truckId, loadNo)` and `plannedStopOf`.
3. `lockOutcomesDay(tx, tenantId, depotId, date)`: `pg_advisory_xact_lock(hashtextextended('outcomes:<tenant>|<depot>|<day>', 0))`, in `lib/delivery/locks.ts`. Bring forward and Undo bring forward take the same lock (§9.2), so a result change and a carry never interleave.
4. Idempotency, under the lock: the stored key is `dl:<uuid>` (§13.3). If a `StopEvent` with that key exists **and has the same `driverLinkId`**, answer `duplicate` with the stored result. If it exists with another `driverLinkId`, answer `refused INVALID` and echo nothing.
5. Upsert the `StopVisit` by its natural key. A new visit gets the planned facts and `firstLoadId`.
6. Validate (§8.2), apply the table above and run the carried check (re-read `carriedToOrderId` and the copy's `carryBasisJson` under the lock).
7. Insert the `StopEvent` (with `clientIp`, `deviceId`, `linkGeneration`).
8. Rebuild the visit from all its events (`deriveVisit`, §8.4), including the plausibility flags, and update it.
9. Write the audit row (§16.4).
10. After the commit: if the load has a BACK_AT_DEPOT event and every stop now has a result, call `completeLoadAsDriver` (§8.7).

A P2002 on the key (a concurrent request on another depot-day lock) aborts that transaction. The handler catches it **outside** the transaction and answers from a fresh read: `duplicate` for the same link, `refused INVALID` otherwise. It never retries inside an aborted transaction (§13.3).

**Positions and times are phone-reported.** The server cannot prove where a phone was: a modified client can send the pin's own coordinates. It checks what it can and marks the rest:
- **Downgrade.** When `mode: 'AUTO'` has no `pos`, or `distanceM(pos, plannedPin) > R + min(acc, R/2) + 25`, the event is stored as **PHONE_MANUAL** with `payload.downgraded = true`.
- **Chained check.** `chained: true` is ignored (the arrival takes `pos.at`) when the planned pins of the two stops are more than `R + 50 m` apart.
- **Plausibility flags** (`payload.suspect[]`, pure `plausibility(events, pin)` in visit.ts): the position equals the pin to 6 decimals; `accuracyM <= 1`; the same non-integer `accuracyM` on three or more automatic events of the visit (iOS reports round values such as 5 or 65, so integers are not flagged); identical ARRIVE and DEPART coordinates (6 decimals); the arrival position more than `2R` from the photo or result position. Any flag sets `StopVisit.timingSuspect`: the visit is left out of measured times, the on-time KPI and the pin check, and the overlay says "unverified timing".

Ayun (§17) becomes the independent cross-check of phone timing.

### 8.4 The visit, rebuilt from its events (lib/delivery/visit.ts, pure)

The function is `deriveVisit(events, { maxAfterOutcomeMin: 15 }) → VisitState`.

1. **Result** = the OUTCOME event with the latest `at`. Ties go to the latest `receivedAt`, then DISPATCHER over the phone. An OUTCOME whose `outcome` is null clears the result.
2. **Cycles.** Sort the ARRIVED and DEPARTED events by `at`. A cycle is a run of ARRIVED events followed by the first DEPARTED. A DEPARTED with no open cycle is ignored.
3. **Chosen cycle.** The one containing `outcomeAt` (arrive ≤ outcomeAt ≤ depart, or depart missing). Else the last cycle that started before `outcomeAt`. Else, with no result, the last cycle.
4. **Arrival** = the earliest ARRIVED in the chosen cycle, with its source, distance and accuracy. A DISPATCHER arrival in the cycle overrides it (an explicit correction). `arrivalObserved` = false when the chosen arrival is an automatic one with `observed: false` (a "when?" chip answer is an earlier PHONE_MANUAL arrival, so it wins and is observed).
5. **Departure** = the DEPARTED closing the cycle. Two exceptions:
   - no DEPARTED and a result exists → `departedAt = outcomeAt`, `departedAtOutcome = true` (GPS lost, or the page was closed);
   - DEPARTED later than `outcomeAt + 15 min` → `departedAt = outcomeAt`, `departedAtOutcome = true` (parked for a break after unloading).
   A DEPARTED with `gap: true` gives the departure time (the last inside fix: a lower bound) but is **not observed**.
6. **Automatic timing** (only from observed events):
   - `autoArrivedAt` = the arrival of step 4 when it is PHONE_AUTO or AYUN and observed; else null;
   - `autoDepartedAt` = the closing PHONE_AUTO or AYUN DEPARTED when observed (no `gap`) and not capped by step 5;
   - with `autoArrivedAt`: `autoBasis = 'DEPARTURE'` and the end is `autoDepartedAt` when it exists; else `autoBasis = 'RESULT'` and the end is `outcomeAt`, when the result's source is PHONE_* (the driver tapped it at the stop) and it is not late; else no automatic timing;
   - `autoMinutes` = end − `autoArrivedAt`, in minutes;
   - `autoServiceMinutes` = end − max(`autoArrivedAt`, the visit's window start), where the window start is the promised start, else the hard receiving start, converted from local minutes on the delivery date. Null when that is ≤ 0, or when [start, end] overlaps the load's planned break (`PlanLoad.breakJson`, copied to the visit's planned facts at the first write).
   - A resumed (not observed) arrival never gives automatic timing.
7. `casesDelivered` = the sum of the lines (null when there is no result). `photoCount` = the photos of the visit. `outcomeLate` = the result event's `payload.late`. `noPhotoReason` = the result event's value. `timingSuspect` = any plausibility flag (§8.3).

### 8.5 The planned stop (lib/delivery/planned-stop.ts)

`plannedStopOf(tx, tenantId, live, truckId, loadNo, sequence)` reads the load's `RouteAssignment` rows at `sequenceInTruck = sequence`, their orders and lines, and computes:
- `lines` = `rowLines(order.lines, portionLinesJson)` per row (the same helper plan-detail uses);
- the pin, hours and `promised` from `readStopSnapshot`;
- the planned ETA and unloading (`departureMin − serviceStartMin`);
- the customer.

If no row has that sequence → `STOP_NOT_FOUND`. A test asserts that these lines equal the manifest's `orderLines` on split fixtures, so the two paths cannot drift.

### 8.6 What the page gets back (`StopResult`)

```ts
{ state: 'PENDING' | 'ARRIVED' | 'DONE'; arrivedAt; arrivalObserved; departedAt; minutes; outcome; reason; casesDelivered;
  photoIds: string[]; noPhotoReason: string | null; late: boolean;
  editable: boolean /* load DISPATCHED and the visit is not in the carry basis of a brought-forward order (§9.4) */;
  carriedTo: string | null /* the copy's date, for any stop holding a brought-forward order */ }
```

`carriedTo` and `editable: false` are set as soon as the carry happens, so the page hides **Change result** on a stop whose result was brought forward, instead of collecting a refusal later. A stop of the same order that had no result at the carry (another part of a split order) stays editable: its first result is still recorded (§9.4).

### 8.7 Back at depot and completion

- **BACK_AT_DEPOT** is a load-level event (`sequence` null). It keeps the position and its distance from the depot pin. It is audited `DRIVER_BACK_AT_DEPOT`.
- `completeLoadAsDriver(tenantId, truckId, date, loadNo, actor)` is added to plan-service.ts.
  - It reuses `inLoadTx` → `lockOpenRun` on the live run, and the same tail as `changeStatusTx` (status, `statusChangedAt`, `statusChangedById = null`, the run status through `appliedPlanStatus`, audit `LOAD_COMPLETED` with `afterJson.actor`, then `refreshPlanFacts`).
  - It runs only when the load is DISPATCHED **and every stop has a visit with a result**.
  - Refactor `changeStatusTx` into a shared internal that takes `actor: { userId: string | null; label: string | null }` and a role check that is skipped only on this path. Nothing else changes.
- When the plan is busy (409) or a stop has no result, the load stays DISPATCHED. The page says "Recorded. The trip closes when every stop has a result."
- **The janitor completes returned loads.** `completeReturnedLoads()` runs in `lib/jobs/janitor-loop.ts` and the cron route, every 60 s. It finds DISPATCHED loads on live plans that have a BACK_AT_DEPOT event and a result on every stop, and calls the same function with actor SYSTEM ("Driver link: <driver> (back at depot)").
- The dispatcher's existing **Completed** button is unchanged: allowed with or without results (D7: no result counts as delivered).
- A load is **final** for Bring forward (§9.1) once it is COMPLETED **or** has a BACK_AT_DEPOT event. A returned load with stops still missing a result stays DISPATCHED, and those stops show at once in the day-end no-result list (§9.1 item 7).

## 9. Bring forward integration (D7)

### 9.1 Changes to lib/dispatch/carry-over.ts

1. **Shortfalls.** A new reader, `outcomeShortfalls(db, tenantId, depotId, dates)`, reads the `StopVisit` rows of those delivery dates that have a result.
   - It returns `VisitShortfall { visitId, truckId, loadNo, sequence, outcome, reason, note, source, late, final, lines: { orderId, lineId, notDelivered }[] }`, where `notDelivered = plannedCases − deliveredCases`, `late = outcomeLate`, and `final` = the visit's load (on the live plan) is COMPLETED or has a BACK_AT_DEPOT event (§8.7).
   - A visit with no result gives nothing: it counts as delivered. The reader also returns, per order, the LEFT_DEPOT parts that have **no** result (`openParts`), for the confirmed rule below.
2. **windowOrders.** `status: { notIn: ['DISPATCHED','DELIVERED'] }` becomes `OR: [{ status: { notIn: ['DISPATCHED','DELIVERED'] } }, { status: 'DISPATCHED', id: { in: shortfallOrderIds } }]`. The orders with a shortfall are read first, for the window's dates.
3. **dayPlans.** The assignments select gains `sequenceInTruck`, and `CarryPlanIn.loads[]` gains `truckId`.
4. **carryCandidates (pure).** It gets `shortfalls: ReadonlyMap<date, readonly VisitShortfall[]>` through `CarryTarget`.
   - The first line becomes: skip when `carriedToOrderId`, or DELIVERED, or (DISPATCHED **and** no shortfall for this order).
   - For each LEFT_DEPOT assignment: `delivered[line] += portionCases[line] − notDelivered(visit at (truckId, loadNo, sequence), line)`, clamped at 0.
   - A visit is matched to the live plan's left load by `(truckId, loadNo)` and an assignment at `sequence` that holds the order. A visit that matches nothing is ignored and logged once: it cannot carry cases the plan does not show.
   - A new why: `{ kind: 'NOT_DELIVERED', text, reason, source }`, with these texts:
     - "Not delivered: Shop closed (driver)"
     - "Partly delivered: 6 of 10 cases not delivered: Damaged goods (dispatcher)"
     - "Not delivered: Other - gate locked (driver)"
   - A new field `confirmed: boolean`, true only when **all** hold:
     - **every** why is NOT_DELIVERED, so all of the open cases come from recorded results;
     - **every** LEFT_DEPOT part of the order has a result (`openParts` empty): a split part still without a result could still be short;
     - for an order of **today**, every visit behind the shortfall is `final`: while the truck is still out, the driver may still change the result (D6);
     - no visit behind the shortfall is `late` (recorded after the trip closed).
   - New fields for the panel: `notFinal` ("truck still out, the result may still change"), `late` ("recorded after the trip closed"), `openPartsText` ("other part (T03 L1 stop 1) has no result").
5. **carry-view.ts.**
   - `carryTickedByDefault(c) = !c.blocked && (c.ofToday ? c.confirmed : !c.late)`. Earlier days stay ticked as today (their whys may be mixed), except a late result, which is never ticked by default; an earlier-day order with an open part is ticked and shows `openPartsText`.
   - An unticked today order with a NOT_DELIVERED why reads, for example: "Not delivered: Shop closed (driver) - truck still out, the result may still change".
   - `carryWhyLabel('NOT_DELIVERED', ofToday)` = "Not delivered today" or "Not delivered".
   - `carryConfirmText` splits today's orders into confirmed ones ("N of them were recorded as not delivered today") and the others (the existing warning).
   - `carryCopyData` writes `lateReason` as "Brought forward from 5 Oct: not delivered (Shop closed, driver)." when the candidate has a NOT_DELIVERED why.
6. **Locks.** `bringForward` takes `lockOutcomesDay` for each window date, in date order, **after** the day locks and before the RunPlan row locks. The lock-order comment in `plan-locks.ts` becomes: intake → day locks → outcome-day locks → RunPlan rows → PlanLoad rows.
7. **No-result list.** `CarryPreview.noOutcome[]` lists stops with no result: `{ date, truckCode, loadNo, sequence, customerCode, branchCode, customerName, cases }`.
   - Only deliveries from the feature's start count: loads whose delivery date is after the local date of `TenantConfig.outcomesSince`, or whose truck-day has a DriverLink or a StopVisit. On deploy day the list is therefore empty, not 2,000 old stops.
   - For the window's earlier days: every stop of a load that left.
   - For today: stops of loads that are COMPLETED, have a BACK_AT_DEPOT event, or whose planned return + 60 min has passed (a DISPATCHED load before that is still on the road).
   - The panel groups them per truck with a count ("T05: 2 stops") and shows them as information under "Dispatched, no result recorded (counted as delivered)". They are never selectable.
8. **checkSelection is unchanged.** `carrySelectionPayload` already adds `today: true` to ticked orders of today. Uniqueness on `carriedFromOrderId` and `carriedToOrderId` still stops a double carry.
9. **The dashboard's `CARRIED_OUT_OF_PLAN`** already subtracts carried orders and counts their copies' cases on the new day. That stays right for outcome-based carries: verify with a test.
10. **Carry basis.** `bringForward` writes, on each copy, `carryBasisJson = { visits: [{ visitId, lines: [{ lineId, notDelivered }] }] }`: the visits and the not-delivered cases it used. The same object goes into the `ORDERS_CARRIED_OVER` audit row. Copies made from non-outcome whys (unserved, not left) get an empty `visits` list.
11. **Shortfall after a carry (information only).** `CarryPreview.lateShortfalls[]` lists orders already brought forward whose current not-delivered cases (from all their visits) exceed the carry basis per line: "Not delivered after it was brought forward: 15 cases of GAMMA (T03 L1 stop 1, Customer refused) - add a late order for 6 Oct". Never selectable: an order is carried at most once (the unique index stays).

### 9.2 Why this never double-delivers or double-carries

- An order is carried at most once (unique index). A second run skips it (`ALREADY_CARRIED`).
- The carry, its undo and a result change serialise on the outcome-day lock. After the carry, `OUTCOME_CARRIED` refuses any change that would shrink the cases brought forward from a visit in the basis (§9.4).
- Today's not-delivered orders are ticked only once the truck is back (or the load Completed), and late results are never ticked, so the usual "driver went back at 16:00 and delivered" case is settled before anything is carried.
- A carried part that never left (LOCKED or LOADING today) blocks that load's dispatch (`carriedOrdersGate`, unchanged).
- The "entered again" check (`laterLines`) still blocks a carry when sales re-keyed the same sales-order line for a later day.

### 9.3 Worked examples

Setup for every example: company today = **5 Oct**, the dispatcher opens day **D = 6 Oct**, depot D1. Order lines are written `product:cases`.

**E1 - Not delivered, today (driver).**
- Situation: order O1 (ACME; lines A:30, B:10 = 40 cases) is on T01 L1, stop 3, DISPATCHED today. At 09:10 the driver records **Not delivered · Shop closed**.
- Preview at 14:00 (T01 still out): O1 is listed in the Today group with "Not delivered: Shop closed (driver) - truck still out, the result may still change", 40 cases, **unticked** (E1b).
- At 16:40 the driver taps Back at depot (or the dispatcher presses Completed). The preview now shows O1 `confirmed`, **ticked by default**.
- Bring forward: the copy O1′ on 6 Oct has A:30, B:10, `carryBasisJson` naming stop 3's visit, and `lateReason` "Brought forward from 5 Oct: not delivered (Shop closed, driver)." O1 gets `carriedToOrderId = O1′`. The driver page hides Change result on stop 3 and shows "Brought forward to 6 Oct".

**E1b - The driver goes back the same day (unticked while out).**
- Same as E1, but at 16:00 the driver returns to ACME and taps Change result → Delivered before Back at depot.
- At 14:00 O1 was unticked, so a default Bring forward did not carry it. After 16:00 O1 is no longer a candidate. Nothing is delivered twice.
- Unit case: a DISPATCHED load → unticked; COMPLETED, or a BACK_AT_DEPOT event → ticked.

**E2 - Partly delivered.**
- Situation: O2 (BETA; A:30, B:10) on T02 L1, stop 1. The driver records **Partly**: A 30 of 30, B 4 of 10, reason Damaged goods.
- Candidate: 6 cases, line B only, `partial: true`, why "Partly delivered: 6 of 40 cases not delivered: Damaged goods (driver)", ticked.
- The copy has one line, B:6, with the weight per case of the original line.

**E3 - Split order, two trucks.**
- Situation: O3 (GAMMA; A:100) is split. Part 1 (A:60) is on T01 L1, stop 2; part 2 (A:40) is on T03 L1, stop 1. Both are DISPATCHED today.
- T01 records Delivered. T03 records **Partly**: 25 of 40, reason Customer refused. Both trucks are back.
- Open = 100 − (60 + 25) = **15**. Listed and ticked; the copy has A:15.

**E3b - Split order, one part without a result yet.**
- Same order, but T01 records **Not delivered** (60) and T03 has no result yet; both trucks are back.
- T03's part counts as delivered for now, so open = 60. `openParts` is not empty, so the order is **not confirmed**: unticked in the Today group with "other part (T03 L1 stop 1) has no result".
- If the dispatcher ticks it anyway, the copy gets A:60 with the basis = T01's visit only. T03's queued "Partly 25/40" then arrives: T03's visit is not in the basis, so the result is **stored**. The next preview lists, as information, "Not delivered after it was brought forward: 15 cases of GAMMA (T03 L1 stop 1, Customer refused) - add a late order for 6 Oct".

**E4 - Split order with an unserved rest (mixed).**
- Situation: O4 (DELTA; A:100). Part 1 (A:60) is on T01 L2, DISPATCHED; the driver records Partly, 50 of 60, Shop closed. Part 2 (A:40) was left **unserved** by the plan (EXCEEDS capacity).
- Open = 100 − 50 = 50. Whys: NOT_DELIVERED (10) + UNSERVED (40). `confirmed` = false, because the unserved part could still go on a later trip today.
- So, in the Today group, it is **unticked** (the existing today rule). If ticked by hand, the copy has A:50.

**E5 - A split order whose other part has not left (double-delivery guard).**
- Situation: O5 (EPS; A:100). Part 1 (A:60) is on T01 L1, DISPATCHED; the driver records **Not delivered**, Wrong location. Part 2 (A:40) is on T04 L2, still **LOCKED** today.
- Open = 100: NOT_DELIVERED 60 + NOT_LEFT 40. Not confirmed, so unticked.
- If the dispatcher ticks it and brings it forward, T04 L2 cannot be dispatched today any more (`ORDERS_CARRIED`, unchanged). No case is delivered twice.

**E6 - Correction after carry-over (dispatcher).**
- After E2's carry, the dispatcher opens T02 L1, stop 1 and records **Delivered** (the customer found the 6 cases). That would shrink the 6 cases brought forward from a visit in the basis.
- Copy not planned yet: answer 409 `OUTCOME_CARRIED` with `undoable: true`. The dialog offers **[Undo the bring forward and record this result]**, which posts #10 again with `undoCarry: true`: one transaction removes the copy (§9.4) and records Delivered. Audited `ORDERS_CARRY_UNDONE` and `DELIVERY_OUTCOME_SET`.
- Copy already planned on 6 Oct (on PLANNED loads only): answer 409 `OUTCOME_CARRIED` with `undoable: false`: "BETA was brought forward to 6 Oct with 6 cases and 6 Oct is already planned with it. A planned order cannot be removed in the app yet: ask an administrator to remove the copy, then record this result." The refused result is kept as a `CARRY_CONFLICT` event (§9.4), so 6 Oct's plan warns on that stop and Lock asks for a confirmation.
- Copy on a LOCKED, LOADING, DISPATCHED or COMPLETED load: `undoable: false`, "BETA's copy is already being loaded or delivered on 6 Oct." Also kept as `CARRY_CONFLICT`.
- The visit itself is unchanged in the last two cases, and nothing is audited as changed.

**E7 - Dispatched with no result recorded.**
- Situation: O6 (ZETA; A:20) on T05 L1, stop 4. T05 L1 is COMPLETED with no result for stop 4.
- O6 counts as delivered, as today, and is not a candidate.
- It appears under "Dispatched, no result recorded (counted as delivered): T05 L1 stop 4, ZETA, 20 cases (5 Oct)".

**E8 - An earlier day, dispatcher-recorded.**
- Situation: on 3 Oct, O7 (ETA; A:12) on T02 L2 had no driver phone. The dispatcher records **Not delivered**, Payment issue, on 4 Oct.
- On 5 Oct, for D = 6 Oct, O7 is listed in the earlier-days group, "Not delivered: Payment issue (dispatcher)", ticked (earlier days are always ticked).

**E9 - A result changed before the carry (race).**
- The dispatcher's list showed O1 with 40 cases. Meanwhile the driver changes it to Delivered.
- Bring forward → 409 `CARRY_OVER_CHANGED` ("No longer open...", the existing `checkSelection` path). Nothing is carried.

**E10 - A backdated change after the trip closed (attack or late phone).**
- T05 L1 is COMPLETED at 17:00. Stop 3 was recorded Delivered by the driver at 11:00. At 21:00 someone holding the link posts OUTCOME NOT_DELIVERED with `at` = 16:59.
- Stop 3 had a result at completion, so the action is refused `LOAD_COMPLETED`. Nothing changes.
- Stop 5 had **no** result at completion. A queued "Not delivered · No one to receive" with `at` = 15:20 arrives at 21:00: accepted, `late`. The overlay shows "recorded after the trip closed"; Bring forward lists it **unticked** with "recorded after the trip closed".

Unit tests (Part 3) encode E1 to E10 (with E1b and E3b) on `carryCandidates`, `carry-view` and the §8.3 rules. Integration (CI) covers E1, E6 (both the undo and the planned-copy refusal) and E10 on the real database.

### 9.4 After a carry: the basis rule and "Undo bring forward" (Part 3)

**The basis rule** (pure `carryChangeCheck(basis, visitId, before, after)` in outcome-rules.ts). For a stop holding an order with `carriedToOrderId`:
- the visit is **not** in the copy's `carryBasisJson`: the change is stored as usual. A new or larger shortfall shows in Bring forward as information (§9.1 item 11);
- the visit is in the basis, and after the change every basis line still has at least as many cases not delivered as the basis says: stored (the shortfall grew or stayed);
- the visit is in the basis, and the change would **reduce** the not-delivered cases of a basis line (more delivered, a cleared result): refused `OUTCOME_CARRIED`, with `undoable` from the rule below. A dispatcher's refused change, or a queued driver change that reaches the server after the carry, is stored as a `CARRY_CONFLICT` event (payload: the refused outcome, lines and who sent it) and audited `DELIVERY_CARRY_CONFLICT`. `deriveVisit` ignores it.

**Where a `CARRY_CONFLICT` shows.** On the original day's overlay ("Driver says Delivered after it was brought forward"). On D's plan, a red chip on the copy's stop: "May not be needed: the 5 Oct result was changed after it was brought forward". **Lock** of a load holding that copy asks: "BETA's brought-forward order may not be needed (the 5 Oct result changed to Delivered). Lock anyway?" It never refuses, so a real shortfall is never held.

`carryChangeCheck` and the `CARRY_CONFLICT` event live in Part 2 (outcome-rules.ts, event-service.ts); a copy without `carryBasisJson` (every copy made before Part 3) has an empty basis.

**Undo bring forward** (`undoCarry(tenantId, originalOrderId, user)` in carry-over.ts; POST #15, and #10 with `undoCarry: true`). Allowed only when the copy has **no plan row in any version** (no `RouteAssignment` and no `UnservedOrder` row): `RouteAssignment.orderId` is `ON DELETE RESTRICT`, and every plan version keeps its own rows, so a planned copy cannot be deleted without rewriting plan history (F12). One transaction:
1. the intake lock; the day locks of the original's date and of D, in date order; the outcome-day locks of the basis visits' days (the order of §9.1 item 6);
2. re-check under the locks: the copy exists, `carriedFromOrderId` = the original, no plan row refers to it (`COPY_PLANNED` / `COPY_ON_ROAD` otherwise), and D's live plan is not OPTIMIZING (`PLAN_BUSY`);
3. clear `carriedToOrderId`, `carriedAt` and `carriedById` on the original first (`Order.carriedTo` is a NO ACTION foreign key, checked at the end of each statement);
4. delete the copy (its order lines and their `IntakeLineKey` rows cascade);
5. audit `ORDERS_CARRY_UNDONE` `{ originalOrderId, copyId, copyDate, cases }`.

It answers `replanNeeded: false` (the copy was on no plan). On a planned copy the refusal names the reason and the way out (an administrator, until the order-cancel flow exists: Q12). The Bring forward panel shows an **Undo** link on today's carried orders whose copy is not planned yet, with the confirm "Remove the copy of ACME on 6 Oct (40 cases)? The order goes back to the list."

## 10. Dispatcher screens (Part 3, except where noted)

### 10.1 Outcome overlay (GET #9)

`lib/delivery/outcome-view.ts` returns, for one version's DISPATCHED and COMPLETED loads:
- `loads[loadId] = { done, total, notDelivered, partly, noResult, backAtDepotAt, driverLink: { lastSeenAt, devices } }`;
- `stops[loadId:sequence] = { state, outcome, reason, note, source, by, arrivedAt, arrivalObserved, departedAt, departureGap, arrivalSource, actualMin, plannedMin, autoTimed, timingSuspect, casesPlanned, casesDelivered, photos: { id, takenAt, distanceM, positionStatus, oldPhoto }[], photoMissing: number, noPhotoReason, late, carriedTo, carryConflict, downgradedArrival }`;
- `summary` (as in §11.4) and `noOutcome[]`.

`plannedMin` is the visit's planned unloading (`departureMin − serviceStartMin`); `actualMin` is `autoServiceMinutes`, else `autoMinutes`, else the observed or manual arrival-to-departure time, with a label saying which.

Visits are matched to the version's loads by `(truckId, loadNo, sequence)`, only for loads that are ON_ROAD in that version. A superseded version shows the same physical results.

### 10.2 plan-view.tsx

- **Loads table, Status cell** (ON_ROAD loads): a chip "Delivered 7/12" plus a red "1 not delivered" / amber "2 no result", and "Back 14:32" when reported.
- **LoadDetail stop table** gains these columns:

| Column | Shows |
|---|---|
| Result | chip with reason, by "driver" or "dispatcher", "→ 6 Oct" when carried; "recorded after the trip closed" when late; "no photo: camera failed (driver)"; a red "changed after it was brought forward" when a `CARRY_CONFLICT` exists |
| Arrived | time, plus "manual", "set by office", or "arrival not observed (page opened at the shop)" |
| Left | time, plus "result time" when `departedAtOutcome`, or "not observed" for a gap departure |
| Unload | "plan 20 / actual 34 min"; "unverified timing" when `timingSuspect` |
| Photos | thumbnail count; opens `photo-viewer.tsx`: full image (fetched as a blob), time, "38 m from pin" or "no location: location off / timed out / poor signal", "taken earlier" when `oldPhoto` |
| — | **[Record]** (PLANNER+) |

- **Record outcome dialog** (`outcome-dialog.tsx`):
  - result radio, reason list, note;
  - per-line steppers, prefilled from the current result;
  - optional "Arrived" and "Left" times (HH:MM, source DISPATCHER);
  - a "Clear result" link.
  - It posts #10. The refusal texts are shown as they come. On `OUTCOME_CARRIED` with `undoable: true` it offers **[Undo the bring forward and record this result]** (§9.4).
- **Part 1 edits in the same file:**
  - the Link action (§6.5), with the links loaded together with the plan (GET #5);
  - the WhatsApp href built synchronously from those links (§6.5);
  - "+ Add daily driver…" as the last option of the Driver list (§14), with the "This phone belongs to Salim" question;
  - Dispatch disabled without a driver, with the title "Pick the driver first: a load never leaves without a driver";
  - the "Reissue link?" prompt after a driver change, only under the conditions of §4.3;
  - the late-dispatch note (§6.5);
  - a "hired" badge after the truck code.

### 10.3 Day screen (dispatch-client.tsx)

A **Deliveries** card for the day:
- "212 of 300 stops have a result · 196 delivered in full · 9 partly · 7 not delivered · 88 no result yet";
- reasons with cases ("Shop closed 4 stops / 160 cases");
- "Arrived inside the window 91 % (of 140 observed arrivals)";
- "No photo: camera failed 3 · Recorded after the trip closed 1".

Below it, the **no-result list** for loads that are back (COMPLETED, BACK_AT_DEPOT, or planned return + 60 min passed), grouped per truck, with [Record] buttons; then the late-dispatch notes (§6.5). The data comes from `getDayOverview(...).deliveries` (§11.4). Days before `outcomesSince` show "Delivery results started on 5 Oct" instead of the card.

The Bring forward panel (`carry-over-panel.tsx`) shows the new why labels, the ticked or unticked state in the Today group with its reason (truck still out, other part has no result, recorded after the trip closed), the **Undo** link (§9.4), the information-only no-result list (§9.1 item 7) and the shortfalls after a carry (§9.1 item 11).

## 11. Data feed (Part 3)

### 11.1 Measured unloading time per customer (D9a)

`lib/delivery/measured.ts`:

```
eligible(v) = v.outcome in {DELIVERED, PARTLY_DELIVERED}
              and v.autoServiceMinutes != null            // an OBSERVED automatic arrival (§8.4), measured from the
                                                          // service start: waiting for the window is not unloading
              and not v.timingSuspect and not v.outcomeLate
              and the stop does not overlap the load's planned break (already null in autoServiceMinutes)
              and 1 <= v.autoServiceMinutes <= min(240, v.plannedServiceMin + 60)   // outliers out
base(v)     = max(0, v.autoServiceMinutes - serviceMinPerCase * v.casesDelivered)   // the same base as Customer.avgServiceTimeMin
measured(c) = the last 10 eligible visits of c (by autoArrivedAt desc); fewer than 3 → null;
              else round(median(base)) minutes, with { n, from, to }
```

The rule of 29 Sep (every split visit takes the FULL base time plus its own cases) makes split visits comparable, so they count. Example: ACME receives from 08:00; the truck arrives (observed) at 07:40, unloads 08:00-08:20 and leaves 08:21. `autoMinutes` = 41, but `autoServiceMinutes` = 21, so the measured time is not inflated by the 20 min wait.

It is shown in the customer dialog on Daily dispatch and in the Customers page row. "Planned" is the **effective** base time (`effectiveAttrs(...).serviceMin`: the customer's confirmed time, else its type's, else the Settings default), never the raw column:

> "Unloading: 20 min planned · measured 34 min (median of 7 timed visits, 12 Sep - 3 Oct)" [Use measured time]

The button is shown to whoever may edit that field today (PLANNER+, the existing `PATCH /api/customers/[id]`). It sends `avgServiceTimeMin = clamp(measured, 1, 480)`, which marks the time confirmed and writes the audit row (UPDATE). Nothing changes automatically.

### 11.2 "Pin may be wrong" list (D9b, admin)

`lib/delivery/pin-check.ts`. A visit's **evidence point**, with accuracy ≤ 100 m, is taken in this order:
1. the median of its photo points with `positionStatus: OK` (Geolocation, else EXIF);
2. else its manual-arrival point;
3. else its result point.

An automatic arrival is never evidence: it is inside the radius by construction. Visits with `timingSuspect` are left out. After the location retention (§12.4) only the stored distances remain: they still count for the flag, but the suggested point uses only visits whose positions are still kept.

```
far(v) = evidence distance from the visit's planned pin > 150 m, or v.reason == WRONG_LOCATION
flag c when at least 2 of the last 3 visits with evidence are far
```

Visits planned at an older pin (their `plannedLat/Lng` more than `PIN_MOVED_M` from the customer's current pin) are left out: that pin was already corrected.

The row shows the customer, the far distances with dates, "Driver said: wrong location (3 Oct)", and a **suggested point** (the median of the far evidence points) as a Google Maps link. The location lock stays: the admin opens the customer and uses the existing Set location. No pin is ever changed automatically.

The list appears as a panel on the Customers page, TENANT_ADMIN only.

### 11.3 "Delivery actuals" Excel (D9c)

GET #12 builds `lib/delivery/actuals-workbook.ts` (exceljs, like the workbook). It has three sheets.

**Stops** (one row per stop of a DISPATCHED or COMPLETED load in the range):

| Group | Columns |
|---|---|
| Where | Date · Depot · Truck · Hired · Trip · Stop · Customer code · Branch · Customer |
| Who | Driver · Daily driver |
| Arrival | Planned ETA · Window · Actual arrival · Arrival by (Auto / Auto, not observed / Manual / Office / Ayun) · Inside window (Yes / No / –; "–" when not observed or unverified) · Minutes early(−)/late(+) |
| Unloading | Planned unloading min · Actual unloading min (from the service start) · Waiting before the window (min) · Timed by (Auto to departure / Auto to result / Manual / Result time / Office) · Unverified timing |
| Result | Result · Reason · Note · Cases planned · Cases delivered · Cases not delivered · Brought forward to · Recorded after the trip closed |
| Proof | Photos · No photo reason · Photo location (OK / poor / off / timed out) · Photo distance from pin (m) · Arrival distance from pin (m) · Recorded by (Driver link / user name) · Result time |

**Summary**: the KPIs of §11.4 for the range. **Reasons**: stops and cases per reason.

The role is PLANNER (per-driver performance data). The range is limited to 31 days. Money never appears.

### 11.4 Outcome KPIs (D9d)

`lib/delivery/kpis.ts` (pure):

```
in scope          = loads whose delivery date is after the local date of outcomesSince, or whose truck-day
                    has a DriverLink or a StopVisit (§9.1 item 7)
dispatchedStops   = stops on ON_ROAD loads of the live plans (day) / of each day (range), in scope
withResult        = visits with a result
deliveredInFullPct = DELIVERED / withResult
casesDeliveredPct  = sum(casesDelivered) / sum(casesPlanned) over visits with a result
notDeliveredByReason = { reason: { stops, cases } }  (NOT_DELIVERED + the missing cases of PARTLY)
timedArrivals     = visits with a window and an arrival that is observed (auto observed, manual, office or Ayun)
                    and not timingSuspect
insideWindowPct   = timedArrivals with localMinutes(arrivedAt) <= windowEnd (an early arrival that waits for the
                    window counts as inside; an open end is unbounded) / timedArrivals
avgUnloadDeltaMin = mean(autoServiceMinutes - plannedServiceMin) over the visits eligible for §11.1
noResult          = dispatchedStops - withResult
```

They appear on the day screen (§10.3) and on the dashboard (`lib/dashboard.ts`): a "Deliveries" tile for the last 7 and 30 days, counting only days in scope.

## 12. Photos

### 12.1 On the phone (lib/driver-page/photo.ts)

1. `<input type="file" accept="image/*" capture="environment">` opens the camera directly. Before it opens, the page saves the stop's draft (§13.1) and notes the tracker's latest fix and the time (`cameraOpenedAt`).
2. **Capture time.** `takenAt` = `Date.now()` when the input's `change` event fires: the device clock, like every other time the page sends (§13.3).
3. **EXIF** is read from the original file before compressing: GPS latitude and longitude, DateTimeOriginal and OffsetTimeOriginal. The reader is `lib/delivery/jpeg.ts`, pure and shared with the server. EXIF time is parsed with OffsetTimeOriginal when present, else in the tenant time zone. It is used **only** for the old-photo check (step 6), never as `takenAt`. EXIF GPS is rarely present on any phone: most Android camera apps ship with location tagging off, the Android photo picker removes it, and iOS strips it from browser captures. It is a bonus only.
4. **Compress without decoding the full image.** Read the SOF size with `jpeg.ts`, then `createImageBitmap(file, { resizeWidth, resizeHeight, resizeQuality: 'medium', imageOrientation: 'from-image' })` to a long side ≤ **1600 px** (a 50 MP capture is never decoded at full size), with an `<img>` + canvas fallback. → `toBlob('image/jpeg', 0.7)`. If the result is over 400 KB, retry at 0.6 and then 0.5. Over 1.5 MB → "Photo too large, retake".
5. **Position.** When the camera returns, `getCurrentPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 15000 })`. The photo keeps the better (smaller accuracy) of that fix and the tracker's last fix from no more than 30 s before `cameraOpenedAt`. **Save never waits for it**: the photo is queued at once, and its meta is filled in when the fix arrives (the queue holds a photo at most 15 s for its position). `positionStatus` is OK (≤ 100 m), POOR, DENIED, TIMEOUT or UNSUPPORTED. A thumbnail without an OK position shows "Location not captured", so the driver can retake it at the shop.
6. **Old photo.** `oldPhoto = true` when the EXIF time or `file.lastModified` is more than 15 min before the stop's arrival (or, without one, the load's dispatch). It catches a gallery photo offered by a browser that ignores `capture`.
7. **Draft.** The compressed photo is written to the queue store as a `draft` item the moment the driver taps Use photo (§13.1). Save only commits the draft keys.

### 12.2 On the server (photo-service.ts)

- Accept only `image/jpeg` whose bytes start with `FF D8 FF`, end near `FF D9`, and have a parseable SOF marker with dimensions ≤ 4000 px. Otherwise 415 `NOT_JPEG`.
- **Strip all metadata** (`stripJpeg` in jpeg.ts, pure): rewrite the file keeping only SOI, DQT, DHT, DRI, SOFn, SOS with its scan data, APP0 (JFIF), APP14 (Adobe, when present) and EOI. APP1 to APP13, APP15 and COM are dropped: no EXIF GPS, make or serial, no embedded thumbnail that could differ from the image, no hidden payload. A direct POST or a client whose canvas path failed therefore stores nothing beyond the picture. The stored `byteSize`, `sha256` and the idempotency comparison use the stripped bytes.
- The key must be a lowercase UUID; it is stored as `dlphoto:<uuid>` (§13.3). The same key with the same hash and the same `driverLinkId` → `duplicate`. The same key with a different hash → 409 `KEY_REUSED`. The same key from another link → `refused INVALID`, nothing echoed.
- `takenAt` is skew-corrected (§13.3) and clamped to [`zonedDayStart(date) − 6 h`, `receivedAt`]; the raw value goes to `rawTakenAt`. A photo needs `takenAt <= expiresAt` in the upload grace (§4.2).
- Distances from the planned pin: `distanceM` (Geolocation, only with a position), `exifDistanceM` (EXIF). `positionStatus` and `oldPhoto` come from the meta.
- Insert `DeliveryPhoto` (with `clientIp`, `deviceId`), a `StopEvent` PHOTO (key `dlphoto:<uuid>`), and bump `photoCount`, under the same lock and visit upsert as §8.3.

### 12.3 Serving

GET #4 and #11 answer with:
- `Content-Type: image/jpeg`
- `Content-Disposition: inline; filename="T05-L1-stop3-1.jpg"`
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: default-src 'none'; sandbox`
- `Cache-Control`: `private, max-age=86400` for tenant users; `no-store` on the driver route.

The driver page loads its thumbnails with `fetch` (the token in the header) into blob URLs, so no image URL carries the token. A purged photo → 404 `PHOTO_PURGED`, and the viewer shows "Photo removed after N days (retention)".

### 12.4 Retention janitor (lib/jobs/delivery-janitor.ts)

Three sweeps run from the janitor loop at most every 10 min (a `globalThis` timestamp) and from the cron route. Each works per tenant in batches of 200, up to 5 batches per sweep, and writes one audit row per tenant per sweep that changed something.

**Photo bytes** (`purgeOldPhotos`), keyed on the **server** time `receivedAt`, so a phone with a wrong clock cannot keep a photo forever or lose it the next day:

```sql
UPDATE "DeliveryPhoto" SET bytes = NULL, "purgedAt" = NOW()
 WHERE id IN (SELECT id FROM "DeliveryPhoto"
               WHERE "tenantId" = $1 AND "purgedAt" IS NULL
                 AND "receivedAt" < NOW() - ($2::int || ' days')::interval
               ORDER BY "receivedAt" LIMIT 200)
```

Audit `DELIVERY_PHOTOS_PURGED` `{count, olderThanDays}`.

**Locations** (`purgeOldLocations`, after `locationRetentionDays`, default 90, never more than `photoRetentionDays`):
- `StopEvent` (by `receivedAt`): `lat`, `lng`, `accuracyM`, `speedMps`, `clientIp`, `deviceId` and the payload's `gpsAt` set to NULL;
- `StopVisit` (by `deliveryDate`): `outcomeLat`, `outcomeLng`, `outcomeAccuracyM`, `arrivalAccuracyM` set to NULL, `locationPurgedAt = NOW()`;
- `DeliveryPhoto` (by `receivedAt`): `lat`, `lng`, `accuracyM`, `exifLat`, `exifLng`, `clientIp`, `deviceId` set to NULL, `locationPurgedAt = NOW()`.
Every `distanceM`, `arrivalDistanceM`, `outcomeDistanceM` and `exifDistanceM` is kept: the KPIs, the actuals Excel and the pin-check flag need only distances. The planned pin (`plannedLat/Lng`) is company data and stays. Audit `DELIVERY_LOCATIONS_PURGED` `{count, olderThanDays}`.

**Daily drivers** (`clearIdleCasualDrivers`, once a day): a casual driver on no load dated within the last 30 days or later (any plan version) is set `active: false` (hidden from the Driver list; the quick add still finds and reactivates them by phone, §14). After `locationRetentionDays` without a load, their `phone` is set to NULL; the name stays, because plans and audit rows show it. Audit `CASUAL_DRIVERS_CLEARED` `{deactivated, phonesCleared}`.

Settings warns, when lowering a retention: "Photos (or positions) older than N days will be deleted for good at the next clean-up."

**Backups.** The deletions above reach the live database only. Railway's volume backups keep the old data until those backups expire, so the real deletion horizon is the retention plus the backup retention. SECURITY.md and admin.md say so.

PostgreSQL reuses the freed TOAST space (autovacuum). The volume itself only shrinks after a `VACUUM FULL` or `pg_repack`, which is an operator task documented in admin.md.

### 12.5 Expected storage growth

Assumptions: a benchmark-size NMWC day has 300 stops (`bench_dispatch.py 300`: 12 trucks, 24 loads), 1.2 photos per stop and **220 KB per photo** (1600 px at JPEG 0.7; typical range 150-350 KB). There are 26 working days a month.

| | Per day | Per month | Steady state at 365 days | At 180 days | At 90 days |
|---|---|---|---|---|---|
| Photos (360 a day) | 79 MB | 2.1 GB | **≈ 25 GB** | ≈ 12 GB | ≈ 6 GB |
| Events and visits (~1,500 rows a day) | < 1 MB | 25 MB | ≈ 0.3 GB | | |

The database backups grow by the same amount. At 1280 px and JPEG 0.6 (~120 KB), the 365-day figure is about 13.5 GB. Stripping metadata (§12.2) saves a few KB per photo, and erasing positions after 90 days changes the row sizes only marginally. The defaults are kept as the coordinator decided (1600 px, 365 days); Q1 asks the owner to confirm them against the Railway volume.

## 13. Offline queue and idempotency

### 13.1 Storage (lib/driver-page/store.ts, queue.ts)

- **IndexedDB** database `riq-driver` with four stores:
  - `queue`, keyed by `key`: items `{ key, ns, kind: 'action' | 'photo', state: 'ready' | 'held' | 'draft', createdAt, attempts, nextAt, body, blob? }`. Photos are stored as Blob; when a Blob put fails (old iOS), as a base64 string.
  - `drafts`, keyed by `${ns}|${stopKey}`: the stop sheet being filled in `{ outcome, reason, note, lines, photoKeys, savedAt }`, written on every change.
  - `manifests`, keyed by `ns`: the last manifest received (§6.2).
  - `links`, keyed by the first 16 hex of `sha256(token)`: `{ ns, trackingOn, deviceId }`, so a reload without signal finds its namespace before any answer, and tracking can restart by itself (§6.3).
- A namespace `${truckId}|${date}`, so a reissued link on the same phone picks up the waiting items. The server checks each item against the new token's truck-day anyway.
- **Drafts.** A photo becomes a `draft` queue item the moment the driver taps Use photo; Save turns the stop's drafts into `ready` items in the same IndexedDB transaction as the OUTCOME action. On load, a stop with a draft reopens its sheet with the draft ("Your last entry was kept"); when the draft names a photo key that is missing (the tab was killed before the camera returned), it adds "The last photo did not arrive - take it again". Cancel deletes the stop's drafts.
- **Clean-up.** On every page load, namespaces whose delivery date is 5 or more days before the phone's date (their upload window ended at 12:00 on D+4) are deleted with their queue, drafts, manifest and `links` entry, and so is a namespace whose link answered `UPLOAD_CLOSED`. A casual or hired driver's phone therefore keeps nothing for long.
- **Fallback.** Without IndexedDB (a blocked private mode or some in-app browsers), an in-memory queue is used, with a red banner: "Keep this page open until everything is sent."
- The pure core (`nextBatch`, `backoff`, `applyResults`, `classify`) takes a storage adapter, so tests use memory.

### 13.2 Sending

- **Triggers:** `online`, `visibilitychange → visible`, every 15 s while visible, and right after an enqueue.
- **Order:** `ready` actions in `createdAt` order, in batches of up to 50 per POST #2. Photos one at a time (POST #3), after the actions created before them, and each held at most 15 s for its position (§12.1). A photo may arrive before its result or after it: the server upserts the visit either way.
- **Held items.** Automatic ARRIVE and DEPART of a LOCKED or LOADING load (held mode, §7.3) are queued as `held`: not sent, not counted as actionable. When a manifest shows that load DISPATCHED, they become `ready` and go out with their original times.
- **Backoff per item:** 5 s, 15 s, 30 s, 60 s, then every 5 min. It never gives up while the link or its upload grace works.

| Result | What the queue does |
|---|---|
| `ok` or `duplicate` | remove the item |
| `refused` (permanent, §8.1) | remove it and show the message (a red row under "Not sent" with the stop name) |
| `refused LOAD_NOT_DISPATCHED` for ARRIVE / DEPART | keep it (`held`) |
| 409 `PLAN_BUSY`, 5xx, network error | keep it for a retry |
| **429** | **transient**: keep every item, wait `Retry-After` seconds (else 60 s) before the next request; never drop |
| 410 with `uploadOnly` | keep sending POSTs; stop the manifest poll |
| 410 `LINK_REPLACED` / `LINK_REVOKED` / 404 | stop sending and polling; the full page of §6.3 lists the unsent results (stop, result, time) for the dispatcher. The items stay for a new link of the same truck-day on this phone, until the clean-up of §13.1 |
| 410 `UPLOAD_CLOSED` | delete the namespace (§13.1) after showing the unsent list once |

- The header chip shows "Waiting to send (n)" with n = `ready` items in the namespace, "All sent ✓", or "No signal" (`navigator.onLine` false).

### 13.3 Idempotency and clocks

**Keys.**
- Every action and photo carries a `key` made once on the phone (`crypto.randomUUID()`, with a fallback to `getRandomValues` formatted as a v4 UUID). Only lowercase UUIDs are accepted.
- The server namespaces the stored key by source: `dl:<uuid>` (driver actions), `dlphoto:<uuid>` (driver photos and their PHOTO events), `disp:<uuid>` (the dispatcher's form, so a double click records once), `ayun:<id>` (later). A driver can therefore never occupy an Ayun or a dispatcher key, and an action key cannot collide with a photo key.
- An existing key counts as a duplicate only when its event (or photo) has the same `driverLinkId` (for `disp:`, the same tenant user). Otherwise the answer is `refused INVALID` and nothing about the stored event is echoed.
- The unique `(tenantId, idempotencyKey)` stays as the last guard. A P2002 is never retried inside the failed transaction (§8.3): PostgreSQL aborts the whole transaction on the first error, so the handler answers from a fresh read outside it.

**Clocks.**
- Every time the page sends (`at`, `pos.at`, `takenAt`) is read from `Date.now()` on the phone: the device clock. `position.timestamp` is sent only as `gpsAt`, for diagnostics.
- Each request carries `clientNow` (also the device clock). The server computes `skew = receivedAt − clientNow` and applies it once to each `at`, `pos.at` and `takenAt` when `|skew| > 2 min`.
- Then it clamps `at` to `≤ receivedAt` and requires `at` within `[zonedDayStart(date) − 6 h, link.expiresAt]`. Otherwise the action is refused `TIME_OUT_OF_RANGE`. A photo's `takenAt` is clamped the same way (§12.2).
- The skew is stored in `payload.clockSkewMs`.

### 13.4 Service worker (public/driver-sw.js, Part 2)

A minimal hand-written worker, registered by the driver page with `scope: '/d/'` (a worker served from `/driver-sw.js` may take a narrower scope without any extra header). It controls only the driver page; no tenant page is affected.
- **Navigations under `/d/`:** network first; on a network failure, the last cached copy of that page. The page is a shell with no data (§6.1), so a cached copy never shows stale stops: the stops come from the manifest stored in IndexedDB.
- **`/_next/static/*`:** cache first (the files are content-hashed, so a cached file is never stale). The cache keeps only the files of the current build: on `activate`, caches whose name is not the build's are deleted.
- **`/api/*`:** never cached, never touched.
- On a message from the page after a 404 or 410, and when the link's upload window has ended, it deletes the cached copy of that page.

This reverses the earlier "no service worker" choice (old C10): network first for the page and content-hashed static files remove the stale-cache risk that choice was about, and without a worker a page reloaded in a dead zone shows the browser's offline page.

### 13.5 What the page shows: server state plus what is still on the phone

`applyQueued(manifest, items)` (pure, lib/driver-page/overlay.ts) lays the unsent and held items over the last manifest:
- an unsent OUTCOME shows its result with the chip "Saved on phone - waiting to send", and sets the stop's `doneAt` for the tracker (so the next stop becomes `expected` and the chained rule sees the result);
- an unsent ARRIVE shows "Arrived 10:02" and the running timer;
- an unsent BACK_AT_DEPOT closes the trip on the phone (the tracker moves to the next trip).

The stop list, the stop sheet and the tracker all read this overlay, never the bare manifest, so a result saved offline is never offered for recording again (which would create a second OUTCOME and more photos). When the server's state for a stop differs from what the phone sent and the phone has nothing left to send for it (the dispatcher, or a second phone such as a helper's, changed it), the stop shows "Changed by office / another phone" instead of flipping silently.

## 14. Rule 20 and daily (casual) drivers (D11, Part 1)

**The gate.** In `changeStatusTx` (plan-service.ts:2196), when `to === 'DISPATCHED'` and the load has no driver after the driver step of the same request (`updateLoad` sets the driver first), the move is refused with 409 `DRIVER_REQUIRED`:

> "T05 L1: a load never leaves without a driver. Pick the driver in the Driver list, or add a daily driver, then dispatch."

- It runs **last**, after every existing gate, so their refusals and the tests that expect them do not change.
- Moves to LOCK, LOADING and COMPLETED are unaffected.
- The plan screen disables Dispatch on a load without a driver, with the same words as the title.

**Quick add.** POST #8 runs in one `inLoadTx`: `lockOpenRun` → validate → `pg_advisory_xact_lock(hashtextextended('casual-driver:<tenant>|<date>', 0))` → find or create the driver → `setDriverTx`.
- The driver is created as `{ code: "DAY-<yyMMdd>-<n>", name, phone, casual: true, active: true }`. Under the advisory lock, `n` = the highest existing `DAY-<yyMMdd>-n` + 1, so two dispatchers adding at once never collide. A P2002 that still happens (an admin typed that code by hand) aborts the transaction: the answer is 409 `CODE_TAKEN` "Try again", never a retry inside the aborted transaction (§13.3).
- **Reuse by phone.** A casual driver (active or not) with the same phone digits is found:
  - the typed name matches theirs (case and spaces ignored): that driver is used, reactivated if needed (`reused: true`);
  - the name differs: 409 `PHONE_BELONGS_TO` `{ driverId, name }`, and the dialog asks "This phone belongs to daily driver Salim. Use Salim?" [Use Salim] [Change the phone]. [Use Salim] posts again with `useExisting`. The audit therefore never names a driver the dispatcher did not choose.
- A regular (non-casual) driver with that phone: the same question, naming them.
- Name: 2-80 characters. Phone: the `driverSchema` regex, optional.
- Audit: `CASUAL_DRIVER_ADDED` (Driver) + `LOAD_DRIVER_SET`. The role is PLANNER, like the Driver list.

**Where daily drivers show.**
- In the Driver list as "Salim (daily)".
- On the Drivers page with a "Daily" badge and a filter. The admin can clear `casual` (PATCH `casual: false`) to make one a regular driver.
- `DRIVER_PUBLIC_SELECT` gains `casual`.
- `planDrivers` needs no change: a daily driver is never a truck's default, and a plan only reuses drivers of its own day's loads.

**Idle daily drivers** (Part 3, §12.4): hidden from the Driver list after 30 days without a load, phone erased after `locationRetentionDays` without a load.

## 15. Hired (rented) trucks: finding (D12)

**How a truck is added today.** Only a TENANT_ADMIN adds one, on the Trucks page (`POST /api/trucks`). It needs a code, a depot, capacities and costs. Every **active** truck of the depot is planned **every day** until it is deactivated. There is no per-day availability.

**The driver flow already works for any truck.** The link is per truck-day and needs no truck setup. A hired truck comes with its own driver, who is added with the daily-driver quick add.

**Added in this build (small and safe; the planner never reads it):**
- `Truck.hired Boolean @default(false)`, a "Hired from outside" checkbox on the truck form (admin);
- badges "hired" on the plan, "HIRED TRUCK" on the PDF and "Hired truck" on the driver page;
- a "Hired" column in the actuals Excel.

**Not added: a dispatcher quick-add of a hired truck for one day.** That would need dated availability, read by `buildDispatchRequest`'s truck query (plan-service.ts:347), and a role change for master data. That changes which trucks every plan uses, so it gets its own spec after the owner answers Q3. Until then the admin adds the hired truck and deactivates it afterwards. The guide says so.

## 16. Security and privacy (D13)

### 16.1 Threats and controls

| Threat | Control |
|---|---|
| Guessing a token | 144-bit tokens; a shape check before any database work; unknown tokens counted per IP (only when the IP is known and not internal); a token that resolves is never blocked by IP (§5). |
| A leaked QR (photo of the sheet, forwarded message) | Reissue / Revoke (§4.3); expiry at 12:00 the next day (uploads only for 72 h more); the link reaches one truck-day only; "used on N phones" in the dialog; after a trip is closed the link can only fill gaps (§8.3), so a forwarded link cannot rewrite results. |
| Token leaking through Referer or search engines | `Referrer-Policy: no-referrer` (header + meta); `rel="noreferrer"` on links; noindex (header + metadata); `Cache-Control: no-store`. |
| Token in our logs and Sentry | The code never logs it. Rate-limit keys use the link id. The API paths carry no token (§4.1). All **four** Sentry inits (client, server, edge, `lib/observability.ts`) get a `tracesSampler` that returns 0 for `/d/` and `/api/d/` (no transaction, no fetch span), plus `beforeSend`, `beforeSendTransaction` and `beforeBreadcrumb` hooks that rewrite `/d/<anything>` to `/d/[token]` in URLs, transaction names and breadcrumbs, and drop the `Authorization` header. The scrubber is one pure function, `scrubDriverToken` (lib/observability-scrub.ts), unit-tested. |
| Token in Railway's HTTP logs | The landing path `/d/<token>` is logged once per page open (and per reload). Accepted: Railway's logs are visible only to the operators; the token expires the next day; reissue kills it. Every API call carries the token only in a header, which Railway does not log. |
| Token sent to Meta through `wa.me` | The WhatsApp link puts the message, with the link, in a `wa.me` query string, so Meta's web servers receive it. Accepted: the message itself goes through WhatsApp anyway; expiry and reissue are the mitigation. |
| Link previews of a forwarded link | The landing page is a shell with a generic title and no data (§6.1): a previewer gets nothing about customers. |
| A VIEWER getting write access through the PDF | The QR is printed only for PLANNER+ (§6.6). #5 to #7 are PLANNER. |
| A dispatcher using the link in their own browser | `withDriverLink` reads the session: writes are stored as DISPATCHER with the user's id (PLANNER+) or refused (§5 step 5), and never pass as the driver's. |
| Cross-tenant or cross-truck reads and writes | `tenantDb(link.tenantId)`; every query filters `truckId` + `date`; stops are resolved only through the link's truck-day; photos only through visits of that truck-day; idempotency keys are honoured only for the same link (§13.3). The new models are in `TENANT_SCOPED_MODELS`. |
| Faked automatic timing | Positions and times are phone-reported and cannot be proven. The server downgrades an automatic arrival far from the pin, ignores a chained arrival between distant pins, clamps times (§13.3), and flags implausible positions (§8.3). Flagged visits never feed measured times, the on-time KPI or the pin check. Ayun is the later cross-check. |
| Upload abuse | `Content-Length` required, ≤ 1.6 MB, JPEG magic bytes and SOF check, all metadata stripped before storing (§12.2), 3 photos per stop, a daily cap per link of 3 × the truck-day's stops + 10, served with nosniff and a sandbox CSP. |
| Replay or double submit | Idempotency keys: lowercase UUIDs, namespaced per source, honoured only for the same link. |
| Squatting another source's keys | A driver key is stored as `dl:` or `dlphoto:`, so it can never take an `ayun:` or `disp:` key (§13.3). |
| CSRF | The driver API takes its credential from a header that a cross-site page cannot set without a CORS preflight, which the API does not allow. A session cookie sent along only turns the request into the office's (§5). The dispatcher routes keep the existing session and same-origin behaviour. |

### 16.2 Rate limits (in-memory limiter, `LIMITS` gains these)

| Key | Limit |
|---|---|
| `dl-bad:<ip>` | 30 unknown tokens (404) / 10 min. Not counted when the IP is null or internal; never counted for a 410; never applied to a token that resolves |
| `dl-get:<linkId>` | 60 / min |
| `dl-act:<linkId>` | 120 **actions** / min (a request counts once per action it carries; review of 4 Oct 2026). Also: at most 2 requests of a link in a write handler at once (actions, photos); the actions body read through a byte-counting reader (413 past 64 KB, Content-Length or not); at most 40 arrivals, departures and results stored per stop and 5 Back at depot per load; a result equal to the stop's current one stores nothing |
| `dl-photo:<linkId>` | per delivery date: 3 × the truck-day's stops + 10 (the per-stop cap of 3, plus retakes); bursts: 60 / 10 min, so a phone that was offline all day can flush at the depot |
| `dl-photo-get:<linkId>` | 120 / min |

Every 429 carries `Retry-After`. The page treats 429 as transient and never drops an item for it (§13.2).

### 16.3 Privacy (driver location is personal data)

- Stored: only **events** (arrival, departure, result, photo, back at depot), each with one position, its accuracy, its distance from the pin, the sender's IP and a random browser id.
- Positions, IPs and browser ids are **erased after `locationRetentionDays`** (default 90; §12.4). Distances stay. Photos are kept `photoRetentionDays` (default 365), stripped of all metadata.
- Never stored or sent: continuous tracks, speed traces or battery.
- On the phone: the queue, drafts and the last manifest are deleted when the truck-day's upload window ends (§13.1).
- Daily drivers: hidden after 30 days without a load; their phone number erased after the location retention (§12.4).
- The notice is shown on first open and from the ⓘ icon. `{company}` is the tenant name and `{days}` the location retention:

> **EN.** "Location: {company} uses your phone's location on this page only while it is open: to start the stop timer when you reach a customer, and to record where delivery photos are taken. It keeps the time and place of each arrival, departure, result and photo for {days} days (the photos themselves longer, as delivery proof), never a track of your route. Questions: ask your dispatcher at {company}."
>
> **AR.** «الموقع: تستخدم {company} موقع هاتفك في هذه الصفحة فقط أثناء فتحها، لبدء مؤقت التوقف عند وصولك إلى العميل ولتسجيل مكان التقاط صور التسليم. تحفظ وقت ومكان كل وصول ومغادرة ونتيجة وصورة لمدة {days} يومًا (وتُحفظ الصور نفسها مدة أطول كإثبات للتسليم)، ولا تسجّل مسار رحلتك. للاستفسار: اسأل مسؤول التوزيع في {company}.»

- docs/SECURITY.md gains a "Driver link" section with the threat table, the retention rules, what is stored, and the **backup horizon**: deleted data stays in Railway backups until they expire, so the real deletion time is the retention plus the backup retention. admin.md says the same.

### 16.4 Audit

New actions, all added to `lib/audit-catalog.ts` **in Part 1**, so handbook 3.13 lists every row once:

| Action | Entity |
|---|---|
| `DRIVER_LINK_ISSUED` | DriverLink |
| `DRIVER_LINK_REISSUED` | DriverLink |
| `DRIVER_LINK_REVOKED` | DriverLink |
| `CASUAL_DRIVER_ADDED` | Driver |
| `DELIVERY_OUTCOME_SET` | StopVisit, with source and before/after; corrections included |
| `DELIVERY_PHOTO_ADDED` | StopVisit |
| `STOP_ARRIVAL_MANUAL` | StopVisit |
| `DRIVER_BACK_AT_DEPOT` | PlanLoad |
| `DELIVERY_CARRY_CONFLICT` | StopVisit |
| `ORDERS_CARRY_UNDONE` | Order |
| `DELIVERY_PHOTOS_PURGED` | Tenant |
| `DELIVERY_LOCATIONS_PURGED` | Tenant |
| `CASUAL_DRIVERS_CLEARED` | Tenant |

New entities: `DriverLink` ("Driver link") and `StopVisit` ("Delivery stop").

- Driver rows have `userId = null` and `afterJson.actor`, built by the pure `driverActor(link, load)`. It keeps D6's form and adds what possession-based access can and cannot tell:
  - normally: "Driver link: Salim (T05, 5 Oct) · link #2";
  - when the link was made for someone else: "Driver link: Khalid (T05, 5 Oct) · link #1 made for Salim";
  - when made before any driver was chosen: "... · link #1 made before a driver was set".
  `afterJson` also carries `linkGeneration`. Review of 4 Oct 2026: driver rows keep **no IP and no phone id** (`AuditLog.ip` empty through `audit({ ip: false })`, no "· phone xxxx" in the actor; also on LOAD_COMPLETED rows written by the link or the janitor), because audit rows are never purged while §16.3 erases a driver's IP and browser id after `locationRetentionDays`; both stay on the `StopEvent` / `DeliveryPhoto` until then. A trip closed by a signed-in user (Record outcome, or the office on the driver page, recording the last result) is that user's row. The Audit log page shows `afterJson.actor` in the user column when `userId` is null.
- Writes by a signed-in office user on the driver page (§5 step 5) are ordinary user rows (`userId` set), with `afterJson.via = "driver page"`.
- Automatic arrivals and departures are **not** audited. `StopEvent` is their record (this avoids about 600 audit rows a day). The handbook says so.

## 17. Ayun later (design notes only)

- Ayun stop events map to `StopEvent` with `source: 'AYUN'` and `idempotencyKey: 'ayun:<eventId>'` (a namespace drivers cannot write, §13.3). The truck is found through a future mapping, plate or `Truck.code` (Q10). The stop is found by `(truck, date)` → the current trip (§7.3) → the pending stop pin within the radius, with the same rules: the expected stop first, a longer dwell for any other, no automatic assignment when two pins are inside together, and no automatic arrival near the depot.
- `deriveVisit` already treats AYUN like an observed PHONE_AUTO for `autoArrivedAt` and `autoMinutes`. When both sources are present, the earliest arrival in the cycle wins.
- Ayun gives true arrival and departure times while the phone page is closed, so it fills exactly the gaps of §7.3, and it is the independent cross-check of phone timing (`timingSuspect`, §8.3).
- Ingestion, the vehicle mapping and the Ayun console are out of scope. The memory note "Ayun tracking console: rules for touching it safely" applies to that later work.

## 18. Tests to write

### 18.1 Unit (`vitest run tests/lib tests/tenant-isolation.spec.ts`)

| Spec | Part | Asserts |
|---|---|---|
| `driver-link-token.spec.ts` | 1 | the same inputs give the same token; a new generation or salt gives a new token; 24 characters `[A-Za-z0-9_-]`; hash = sha256; `keyId` changes with the key; DRIVER_LINK_SECRET over NEXTAUTH_SECRET over AUTH_SECRET; expiry = 08:00Z of D+1 for Asia/Muscat (also 31 Oct → 1 Nov); `linkUploadUntil` = expiry + 72 h. |
| `driver-link-service.spec.ts` | 1 | ensure creates once under the advisory lock, and a fake tx that throws P2002 is never retried in the same transaction; ensure on a revoked link stays revoked and returns no token; reissue → generation+1, `prevTokenHash` set, the old token → 410 `LINK_REPLACED`, the one before → 404; revoke → 410; expired → 410 (`uploadOnly` inside the grace, `UPLOAD_CLOSED` after) and ensure → 409 `LINK_DAY_OVER`; **a link whose `keyId` differs from the current key → 410 `LINK_REPLACED`** and ensure rewrites it; `reissuePrompt` (null `driverIdAtIssue` → silent; trip 2 driver change while trip 1 is out → no prompt; earliest open load → prompt); `devicesJson` capped at 5 and written at most every 5 min; audit rows written; no token in any audit `afterJson`. |
| `driver-manifest.spec.ts` | 1 | built from `plan-detail-fixture`: only the truck's loads; `actionable` only for DISPATCHED; no money or priority keys (deep key scan); `orderLines` and structured hours present; split label; carriedFrom; two depots; no live plan → empty; `office` set only with a session. |
| `driver-page-i18n.spec.ts` | 1 | EN and AR have identical keys; no empty string; every AR string has an Arabic letter; every `NotDeliveredReason`, every LoadStatus and every `PhotoPositionStatus` has a label; placeholders match per key. |
| `observability-scrub.spec.ts` | 1 | `scrubDriverToken` rewrites `/d/<t>` in URLs, transaction names and breadcrumbs, drops the `Authorization` header; the `tracesSampler` returns 0 for `/d/` and `/api/d/` and the configured rate otherwise; all four Sentry inits use it (a source scan). |
| `webview-gate.spec.ts` | 1 | the UA detector (`; wv)`, FBAN, FBAV, Instagram, Line/, Snapchat; plain Chrome and Safari not flagged); the Chrome intent URL is built and encoded correctly. |
| `plan-lifecycle.spec.ts` (extended) | 1 | dispatch without a driver → 409 `DRIVER_REQUIRED`; driver + dispatch in one request → ok; the gate comes after the timing / location / carried gates; LOCK and COMPLETED unaffected. |
| `casual-driver.spec.ts` | 1 | code format under the advisory lock; P2002 → 409 `CODE_TAKEN` with no retry in the aborted transaction; reuse by phone with the same name (and reactivation); `PHONE_BELONGS_TO` when the name differs, then `useExisting`; validation; refused on a load on the road. |
| `driver-pack.spec.ts`, `whatsapp` cases (extended) | 1 | the driver link printed first with the "Scan with the phone camera" caption and route QRs capped at 2; no link → placeholder; **revoked → "Driver link stopped"**; an ensure failure for one truck → that truck's placeholder, the pack still built; WhatsApp line present only with an active link, absent for revoked, expired and missing links. |
| `dispatch-export-routes.spec.ts` (extended) | 1 | the PDF calls ensure only for PLANNER+; a VIEWER gets the placeholder. |
| `api-role-matrix.spec.ts` + `.ts` | 1, 2, 3 | the DRIVER_LINK class; every new route in EXPECTED (§5). |
| `repo-guards.spec.ts` (extended) | 1 | every `app/api/d/**/route.ts` uses `withDriverLink(`; no `[token]` folder under `app/api/d`; nothing under `app/d/**` or `lib/driver-page` imports `@/lib/db`, `@prisma/client` or `lib/driver-link/service` (the page is a shell, and the client bundle stays clean); no `console.` call in `lib/driver-link/*` takes a token; no new route under `/api/driver/`. |
| `tenant-isolation.spec.ts` (extended) | 1 | DriverLink, StopVisit, StopEvent and DeliveryPhoto are scoped both ways. |
| `audit-redaction.spec.ts` (extended) | 1 | `salt` and `prevTokenHash` are redacted. |
| `geofence.spec.ts` | 2 | §7.4 (25 cases). |
| `delivery-visit.spec.ts` | 2 | §8.4: result by latest `at`; null clears; cycle choice; earliest arrival; dispatcher override; the 15-min cap; a resumed arrival → `arrivalObserved` false and no automatic timing; a gap departure → not observed, `autoBasis` RESULT; `autoBasis` DEPARTURE with both ends observed; `autoServiceMinutes` from the window start (early arrival with a wait), null across the planned break; `outcomeLate`; `noPhotoReason`; the plausibility flags (pin-equal position, accuracy ≤ 1, identical coordinates, far photo); out-of-order events; a DEPARTED before any ARRIVED ignored; `CARRY_CONFLICT` ignored. |
| `delivery-outcome-rules.spec.ts` | 2 | §8.2 and §8.3 tables row by row (including `CAMERA_FAILED`, gap-filling after COMPLETED, `LOAD_NOT_DISPATCHED` transient for ARRIVE); `carryChangeCheck` (§9.4); skew correction and clamps; a phone clock 10 min fast. |
| `jpeg.spec.ts` | 2 | accept a minimal JPEG; reject PNG, GIF, HTML, an HTML-prefixed JPEG and a truncated file; SOF dimensions; EXIF GPS (N/S/E/W), DateTimeOriginal and OffsetTimeOriginal from bytes built in the test; EXIF time without an offset read in the tenant time zone; malformed EXIF → null, never a throw; **`stripJpeg`: an input with EXIF GPS, an embedded thumbnail and a COM payload comes out without them, still a valid JPEG with the same scan data**. |
| `driver-queue.spec.ts` | 2 | backoff schedule; ordering (actions before later photos); `ok`/`duplicate` remove; `refused` removes and reports; `LOAD_NOT_DISPATCHED` on ARRIVE stays held; 409/5xx keep; **429 keeps every item and waits `Retry-After`**; `uploadOnly` keeps sending POSTs only; 404/410 stop; `UPLOAD_CLOSED` deletes the namespace; held items released when the load is DISPATCHED; drafts committed with Save in one transaction; namespace pickup after a reissue; clean-up of namespaces past their window. |
| `driver-overlay.spec.ts` | 2 | `applyQueued`: an unsent result shows "Saved on phone" and sets `doneAt`; an unsent ARRIVE shows the timer; an unsent BACK_AT_DEPOT moves the current trip; a server state that differs with nothing left to send → "Changed by office / another phone". |
| `driver-routes.spec.ts` | 2 | through the handlers with a fake db: no or bad header → 404 with no db call; unknown → 404 + IP counter, but **no count when the IP is null or internal**; a known token is never blocked when its IP is over the limit; `prevTokenHash` → 410 `LINK_REPLACED` without a count; revoked/expired → 410; upload grace: GET 410 `uploadOnly`, POST with `at <= expiresAt` accepted and flagged late, later `at` refused; 413/411/415; 429 with `Retry-After`; the photo daily cap; another truck-day's stop → `STOP_NOT_FOUND`; **E10: a backdated OUTCOME on a COMPLETED load whose stop had a result → `LOAD_COMPLETED`; a gap-fill → accepted, `late`**; key not a lowercase UUID → `INVALID`; **an existing key of another link → `INVALID` with nothing echoed; `ayun:1000` as a driver key → `INVALID` (not a UUID), and a valid UUID is stored as `dl:<uuid>`, so it can never take an `ayun:` key**; a photo key equal to an action key → both stored; a session of the link's tenant → DISPATCHER source; a VIEWER session → 403. |
| `carry-over.spec.ts` (extended) | 3 | E1-E10 with E1b and E3b (§9.3); the confirmed rule (final, open parts, late); `carryTickedByDefault`; `carryWhyLabel`; `carryConfirmText` split; `lateReason` text; the carry basis written; `lateShortfalls`; `noOutcome` list rules (pre-feature days empty, a returned DISPATCHED load listed, grouped per truck). |
| `carry-undo.spec.ts` | 3 | undo deletes an unplanned copy and clears the original's carry fields in that order; refused `COPY_PLANNED` when a RouteAssignment or UnservedOrder row refers to the copy; `COPY_ON_ROAD`; `PLAN_BUSY` while D's plan is optimizing; the lock order; the audit row. |
| `delivery-measured.spec.ts` | 3 | median of the last 10, fewer than 3 → null, per-case subtraction, exclusions (suspect, late, not observed, over plan + 60); early arrival with a wait; a break at the stop; "planned" from `effectiveAttrs` for an unconfirmed customer. |
| `delivery-pin-check.spec.ts` | 3 | 2 of 3 rule, 150 m, the accuracy filter, only `positionStatus: OK` photos, suspect visits excluded, WRONG_LOCATION counts, an older pin excluded, the suggested point, purged positions still counted by distance. |
| `delivery-kpis.spec.ts` | 3 | every formula of §11.4, empty days, open-ended windows, an early arrival counted inside, resumed arrivals excluded, days before `outcomesSince` out of scope. |
| `delivery-actuals-workbook.spec.ts` | 3 | sheets, headers, one row per stop, no money columns, the new observed / late / no-photo columns. |
| `delivery-janitor.spec.ts` | 3 | photo purge by `receivedAt` (a `takenAt` in 2031 is still purged; a `takenAt` in 2020 received today is kept); location purge nulls the positions, IPs and device ids and keeps every distance; `locationRetentionDays` capped at `photoRetentionDays`; idle daily drivers deactivated at 30 days and their phone erased later; batch size and loop bound; one audit row per sweep with count > 0. |

### 18.2 Integration (CI only: `tests/integration/driver-link-flow.spec.ts`, one file grown across the parts)

- **Part 1:**
  - issue a link through #6;
  - `GET /d/<token>` answers 200 with `X-Robots-Tag` and `Referrer-Policy: no-referrer`, and its HTML holds no customer name of the fixture (the shell);
  - `GET /api/d/manifest` with `Authorization: DriverLink <token>` gives the truck's loads only; without the header → 404;
  - another tenant's session cannot use #5 to #7 on this link (404);
  - after a reissue the old token → 410 `LINK_REPLACED`;
  - dispatch without a driver → 409 `DRIVER_REQUIRED`;
  - casual quick add + dispatch → 200; the same phone with another name → 409 `PHONE_BELONGS_TO`.
- **Part 2:**
  - ARRIVE AUTO at the pin, OUTCOME DELIVERED with a photo key, then the photo upload (a tiny JPEG fixture with an EXIF block: the stored bytes have none);
  - the same batch replayed → all `duplicate`, counts unchanged;
  - NOT_DELIVERED on stop 2;
  - BACK_AT_DEPOT → load COMPLETED (audited with the actor);
  - a later backdated outcome on stop 1 → `LOAD_COMPLETED`; a gap-fill on a stop without a result → accepted, `outcomeLate`;
  - another tenant's token cannot read the photo;
  - an AUTO arrival 2 km away is stored PHONE_MANUAL (downgraded);
  - an ARRIVE on a LOADING load → `LOAD_NOT_DISPATCHED` (transient), accepted after Dispatch.
- **Part 3:**
  - the carry-over preview for D+1 lists stop 2's order with "Not delivered: … (driver)", `confirmed` once the load is COMPLETED;
  - bring forward carries it and writes `carryBasisJson`;
  - the dispatcher's correction → 409 `OUTCOME_CARRIED` with `undoable: true`; with `undoCarry: true` the copy is gone and the result recorded;
  - after planning D, the same correction → `undoable: false` and a `CARRY_CONFLICT` event;
  - `GET /api/delivery-photos/<id>` → 200 for the tenant user, 404 for the other tenant;
  - actuals xlsx downloads.
- `tests/integration/carry-over.spec.ts` gains E1, E6 and E10 on the real database.

### 18.3 Tests that rule 20 breaks (Part 1 must update them)

- **Unit:** `tests/lib/plan-lifecycle.spec.ts` (dispatch calls near lines 459, 532, 587, 1427, 1678, 1700; set a driver in the fixture or in the same `updateLoad` call).
- **Unit, to check:** `tests/lib/plan-feasibility-gate.spec.ts:170` and `tests/lib/carry-over.spec.ts:803/811` expect other refusals. They stay green because the new gate runs last.
- **Integration (CI):**
  - `dispatch-mvp.spec.ts:316`
  - `dispatch-split.spec.ts:249`
  - `driver-pack.spec.ts:286`
  - `intake-confirm.spec.ts:276`
  - `location-rule-db.spec.ts:422`
  - `plan-lifecycle-db.spec.ts:216`
  - `same-day-plan-db.spec.ts:220`
  - `carry-over.spec.ts:313` expects ORDERS_CARRIED: check the gate order.
- The builder greps `status: 'DISPATCHED'` and `{ status: 'DISPATCHED' }` across `tests/` to catch any missed.

## 19. Docs to update

| Doc | Part | What |
|---|---|---|
| `docs/PROJECT_HANDBOOK.md` | 1, 2, 3 | sections 1-2 counts (routes +4/+3/+7, migrations +1, models +4, enums +5); 2.2 file map (`lib/driver-link`, `lib/delivery`, `lib/driver-page`, `app/d`, `public/driver-sw.js`); 2.9 env (`DRIVER_LINK_SECRET` optional; rotating NEXTAUTH_SECRET or DRIVER_LINK_SECRET makes every driver link answer "replaced" until reopened or reprinted); 2.10 a third principal, the driver link (token in a header; a signed-in browser acts as the office); 3.8/3.9 rule 20 and daily drivers (phone reuse question, idle clean-up); 3.10 PDF QR and the actuals Excel; **new 3.18 "Delivery outcomes and the driver page"** (flow, current trip, observed vs. resumed arrivals, timer algorithm, outcome rules, gap-filling after completion, upload grace, Bring forward integration, carry basis, Undo bring forward); 3.13 audit rows (all in Part 1); 3.14 statuses; 3.15 data model; 3.16 API map; 3.17 Module C still retired, the new page separate; 5.3 every new spec; 5.9 janitor (returned-load completion, photo purge, location purge, idle daily drivers); 5.11 gotchas (HTTPS needed for geolocation and the camera; wake lock; EXIF GPS rarely present; in-app browsers and the Open in Chrome card; the camera can kill the tab on small phones; `position.timestamp` is not the device clock; P2002 aborts a PostgreSQL transaction); 6.2 decisions; 7.2 limitations (the timer works only while the page is open; unobserved arrivals; a planned brought-forward copy cannot be removed in the app; the line "no undo bring forward" at ~2986 becomes "undo only before the copy is planned"); 7.5 open questions |
| `docs/DISPATCHER_GUIDE.md` | 1, 2, 3 | new sections "Driver link (QR) and the driver page" (scan with the phone camera; Open in Chrome; used on N phones; when to reissue), "Daily drivers and hired trucks", "Delivery results" (what "arrival not observed", "recorded after the trip closed", "no photo: camera failed" and "unverified timing" mean); updated "Driver sheets" (the QR), "5. Lock, export, dispatch" (rule 20; the late-dispatch note: "Dispatch it when it leaves, or the driver's first arrival times wait on his phone"), "Bring forward" (results; today's group ticked once the truck is back; the no-result list; Undo bring forward; shortfalls after a carry), "Settings (company admins)" (5 settings). The existing guard bullets stay. |
| `docs/SECURITY.md` | 1 | driver link threat model (§16), including Railway logs, `wa.me` and link previews as accepted risks; retention and the backup horizon |
| `docs/admin.md` | 3 | revoking links; key rotation; photo and location retention and disk space; the backup horizon; `VACUUM FULL` note |

## 20. Build split

The parts are built **in order, 1 → 2 → 3**, on the branch `delivery-outcome-driver-page`. Each part leaves unit tests, `tsc`, lint, the drift check and the repo guards green, and updates the handbook counts for what it adds.

Ownership below says which part may change which file. A later part may edit an earlier part's file only where its row lists it.

### Part 1: foundations

**New:**
- `prisma/migrations/20261004090000_delivery_outcome_driver_page/migration.sql`
- `lib/driver-link/token.ts`, `service.ts`, `guard.ts`, `manifest.ts`, `manifest-types.ts` (browser-safe types), `actor.ts` (`driverActor`), `reissue-prompt.ts`
- `lib/driver-page/i18n.ts`, `format.ts`, `webview.ts` (detector and intent URL), `api.ts` (fetch with the header and the device id)
- `lib/observability-scrub.ts`
- `lib/dispatch/qr.ts`, `lib/dispatch/casual-driver.ts`
- `app/d/[token]/layout.tsx`, `page.tsx` (shell), `driver-page.tsx` (read-only client), `link-state.tsx` (error states), `webview-gate.tsx`
- `app/api/d/manifest/route.ts`, `app/api/dispatch/driver-links/route.ts`, `app/api/dispatch/driver-links/[id]/route.ts`, `app/api/dispatch/casual-driver/route.ts`
- `app/t/[slug]/dispatch/driver-link-dialog.tsx`, `casual-driver-dialog.tsx`
- `tests/lib/driver-link-token.spec.ts`, `driver-link-service.spec.ts`, `driver-manifest.spec.ts`, `driver-page-i18n.spec.ts`, `casual-driver.spec.ts`, `observability-scrub.spec.ts`, `webview-gate.spec.ts`
- `tests/integration/driver-link-flow.spec.ts`

**Edited:**
- `prisma/schema.prisma` (everything in §3)
- `lib/tenant.ts`, `lib/audit-catalog.ts` (all §16.4 actions and entities), `lib/audit.ts` (`salt`, `prevTokenHash`)
- `lib/client-ip.ts` (export `isInternalIp`)
- `lib/dispatch/plan-detail.ts` (the additive DetailStop fields)
- `lib/dispatch/plan-service.ts` (rule 20 gate only)
- `lib/dispatch/driver-links.ts`, `lib/dispatch/driver-pack.tsx`, `app/api/runs/[id]/export/pdf/route.ts`
- `app/t/[slug]/dispatch/plan-view.tsx` (§10.2 Part 1 bullet)
- `lib/driver-fields.ts`, `lib/schemas.ts` (truck `hired`, driver `casual`, the 5 settings, casual-driver body), `lib/settings-fields.ts`
- `app/api/tenant/config/route.ts`, `app/api/trucks/*`, `app/api/drivers/[id]/route.ts`
- the Trucks / Drivers / Settings pages (`truck-form.tsx`, `drivers-table.tsx`, `settings-form.tsx`)
- `lib/rate-limit.ts` (LIMITS), `next.config.js`, `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, `lib/observability.ts`
- `tests/lib/api-role-matrix.ts` + `.spec.ts`, `repo-guards.spec.ts`, `tenant-isolation.spec.ts`, `audit-redaction.spec.ts`, `driver-pack.spec.ts`, `dispatch-export-routes.spec.ts`
- the tests of §18.3
- docs (§19, Part 1 rows)

**Accept when:**
- a dispatcher can open Link on a plan, scan the QR on a phone and see the read-only page in EN and AR;
- the QR opened from inside an in-app browser shows the Open in Chrome / Safari card;
- the page's HTML holds no customer data, and no API request carries the token in its path;
- the PDF shows the QR for PLANNER+ only, and "Driver link stopped" after a revoke;
- WhatsApp carries the link, and opens the dialog when the truck has no link yet;
- dispatch without a driver is refused, and a daily driver can be added from the load;
- the hired badge shows.

### Part 2: field actions

**New:**
- `lib/delivery/geofence.ts` (with `currentTrip`, `restoreTracker`), `visit.ts` (with `plausibility`), `outcome-rules.ts` (with `carryChangeCheck`), `jpeg.ts` (with `stripJpeg`), `planned-stop.ts`, `locks.ts`, `event-service.ts`, `photo-service.ts`
- `lib/driver-page/queue.ts`, `photo.ts`, `overlay.ts` (`applyQueued`), `store.ts` (the four IndexedDB stores and the clean-up)
- `public/driver-sw.js`
- `app/d/[token]/use-tracker.ts`, `stop-sheet.tsx`, `outcome-flow.tsx`, `camera-button.tsx`, `sync-badge.tsx`, `arrived-when.tsx`, `which-customer.tsx`
- `app/api/d/actions/route.ts`, `app/api/d/photos/route.ts`, `app/api/d/photos/[photoId]/route.ts`
- `tests/lib/geofence.spec.ts`, `delivery-visit.spec.ts`, `delivery-outcome-rules.spec.ts`, `jpeg.spec.ts`, `driver-queue.spec.ts`, `driver-overlay.spec.ts`, `driver-routes.spec.ts`

**Edited:**
- `lib/dispatch/plan-service.ts` (`completeLoadAsDriver` and the shared status-change internals)
- `lib/jobs/janitor-loop.ts` + `app/api/cron/janitor/route.ts` (`completeReturnedLoads`)
- `lib/driver-link/manifest.ts` (merge `StopResult`)
- `app/d/[token]/driver-page.tsx`
- `tests/integration/driver-link-flow.spec.ts` (Part 2 steps)
- `tests/lib/api-role-matrix.spec.ts`
- docs (§19, Part 2 rows)

**Accept when:**
- on a phone at a synthetic pin the timer starts by itself after about 20 s, and an arrival found only when the page is reopened asks "when?";
- Delivered / Partly / Not delivered work with photos, and "Camera not working" saves without one;
- airplane mode queues and later sends without duplicates; a result saved offline shows "Saved on phone" and is not offered again;
- **the tab killed during the camera** (Chrome's "discard" on a small phone, or `chrome://discards`): on return, the stop sheet reopens with its draft and the timer with its original arrival time;
- the page reloaded in airplane mode shows the last stops (service worker + stored manifest);
- arrivals recorded on a LOADING load are sent once it is Dispatched;
- Back at depot completes the load.

### Part 3: office side

**New:**
- `lib/delivery/outcome-view.ts`, `measured.ts`, `pin-check.ts`, `kpis.ts`, `actuals-workbook.ts`
- `lib/jobs/delivery-janitor.ts`
- `app/api/runs/[id]/outcomes/route.ts`, `app/api/dispatch/outcomes/route.ts`, `app/api/delivery-photos/[id]/route.ts`, `app/api/dispatch/delivery-actuals/route.ts`, `app/api/customers/delivery-stats/route.ts`, `app/api/customers/pin-check/route.ts`, `app/api/dispatch/carry-over/undo/route.ts`
- `app/t/[slug]/dispatch/outcome-dialog.tsx`, `photo-viewer.tsx`, `delivery-summary.tsx`
- `app/t/[slug]/customers/pin-check-panel.tsx`
- the §18.1 Part 3 specs

**Edited:**
- `lib/dispatch/carry-over.ts` (shortfalls, confirmed rule, carry basis, `undoCarry`), `carry-view.ts`, `plan-locks.ts` (comment)
- `lib/dispatch/plan-service.ts` (the Lock confirmation for a copy with a `CARRY_CONFLICT`: a warning in the answer, never a refusal)
- `app/t/[slug]/dispatch/carry-over-panel.tsx`, `plan-view.tsx` (the overlay), `dispatch-client.tsx`, `customer-dialog.tsx` / `customer-details.ts`
- `lib/dispatch/day-overview.ts`, `lib/dashboard.ts` + the dashboard page
- the Customers page
- `lib/jobs/janitor-loop.ts` + the cron route (the photo, location and daily-driver sweeps)
- the Audit log page (show `afterJson.actor` for driver rows)
- `tests/lib/carry-over.spec.ts`, `tests/integration/carry-over.spec.ts`, `driver-link-flow.spec.ts` (Part 3 steps), `api-role-matrix.spec.ts`
- docs (§19, Part 3 rows, final pass)

**Accept when:**
- the plan shows progress, results, times and photos, and the dispatcher can record or correct a result;
- Bring forward lists recorded results ticked (today's once the truck is back), refuses a correction that would shrink a carried shortfall, and undoes a carry whose copy is not planned;
- measured times, the pin list, the actuals Excel and the KPIs all show, and ignore unobserved, late and unverified timings;
- old photo bytes and old positions are purged, and idle daily drivers are hidden.

**Commit rules (every part):** CRLF working copy, Edit tool only. The trailer is a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push, no `gh`, no Railway.

## 21. Coordinator decisions changed or refined, and why

| # | Decision | Change | Why |
|---|---|---|---|
| C1 | D1 "token stored only hashed" | The database stores only the SHA-256 hash and a random 128-bit salt. The token is **re-derived** on the server as HMAC(server key, id + generation + salt). | Every PDF and WhatsApp message must print the same link again at any time; a hash-only store cannot show a token twice. A database leak alone still gives no token (it needs NEXTAUTH_SECRET or DRIVER_LINK_SECRET). Reissue rotates the salt and generation; a key rotation kills every link. |
| C2 | D4 reasons | A reason is **required for Partly** too (same list), and **NOT_ON_TRUCK** ("Missing from the truck") is added. | Bring forward must say why the missing cases were not delivered (D7). A short-loaded truck is the most common partial cause, and it points to loading, not to the customer. |
| C3 | D1/D11 "one driver per truck per day" | Not enforced. The code allows a driver per load (F6); one link covers the truck-day, the audit names the load's driver, and the plan shows a notice. | Enforcing it would change `planDrivers` and the driver rules on live plans. That is out of scope and not needed for the flow. |
| C4 | D6 "driver may change until COMPLETED" | Until COMPLETED, as decided. After it, the link may only **fill gaps**: a late result is accepted (with `at` before completion, inside the upload window) only for a stop that had no result at completion, flagged late and never ticked by default; a result that existed at completion cannot be changed by the link at all. | `at` is client-asserted, so judging by it alone let anyone holding the link rewrite closed trips (E10). Gap-filling still saves offline results. |
| C5 | D3 departure | The stop ends at the result time when the departure is missing (GPS lost, page closed) **or more than 15 min after the result** (parked for a break). Neighbouring shops chain the arrival only when their pins are within R + 50 m and fixes were continuous since the result. | Otherwise the measured unloading would absorb lunch breaks and walks to the next shop, and a page reopened after driving would chain a false arrival. |
| C6 | D7 Today group | Ticked by default only when **all** of the order's open cases are recorded as not delivered, every left part has a result, the truck is back (BACK_AT_DEPOT or Completed), and no result is late. Otherwise listed unticked with the reason. | While the truck is out the driver may still change the result (D6); a part with no result may still be short; a mixed case may still leave today (E1b, E3b, E4, E5). |
| C7 | D1 PDF | The QR is printed only for PLANNER+. | The PDF route is open to VIEWER and the link can write results. |
| C8 | D12 | Only the `hired` flag; the day-limited quick add is a follow-up. | It changes which trucks every plan uses and who may add master data (§15). |
| C9 | D9c role | The actuals Excel is PLANNER+ (not VIEWER). | It is per-driver performance data. |
| C10 | D5 | **Revised:** a minimal service worker scoped to `/d/` (network first for the page shell, cache first for content-hashed static files, never the API), the last manifest kept in IndexedDB, and unsent results shown on the page (§13.4, §13.5). | Without it a page reloaded in a dead zone is dead and a result saved offline could be recorded twice. The shell holds no data, so caching it carries no stale-data risk. |
| C11 | D3 storage | Only the event positions are stored, and they are erased after 90 days (setting). Automatic arrivals and departures are **not** audited (StopEvent is their record). | Privacy (Oman PDPL), and about 600 audit rows a day of noise. Distances are enough for the KPIs and the pin check. |
| C12 | D1 "token in the path" | The token is in the path of the QR landing page only; the API takes it in a header on token-free paths, and the landing page is a data-free shell. | Every poll, upload and thumbnail would otherwise write the live token into Railway's logs and Sentry traces, and a link previewer would receive the customer list. |
| C13 | D1 "valid until 12:00 the next day" | Unchanged for reading and new results; **plus a 72 h upload-only grace** for results recorded before expiry. | A casual driver without data credit would otherwise lose a day's results, photos and timings for good (a reissue cannot extend a past day). |
| C14 | D3 "timer starts automatically" | Automatic arrivals are split into **observed** (seen arriving) and **resumed** (found inside when the page came back). Only observed ones feed measured times and the on-time KPI; a resumed one asks "Arrived when?". Tracking may start from 30 min before departure on a LOCKED or LOADING load, held on the phone until Dispatch. | The page cannot see while the driver uses Maps or the camera; counting what it did not see would bias measured unloading towards 1 min and plans would overrun closing. A late Dispatch click would lose the first stops. |
| C15 | D4 "photo required" | One exception: "Camera not working" (`CAMERA_FAILED`), shown as such everywhere. | An in-app browser or a broken camera would otherwise block every Delivered. |
| C16 | D6 "a correction is refused once brought forward" | Refused only when it would shrink cases already carried from that visit (the carry basis); other changes are stored and a new shortfall is listed as information. "Undo bring forward" removes a copy that is not planned yet; a planned copy cannot be removed in the app (F12, Q12), so the refused change is kept as a `CARRY_CONFLICT` that warns on the copy's plan. | Refusing every change lost real shortfalls on split orders, and the refusal named a remedy the app did not have. |
| C17 | D11 "changing the driver prompts Reissue" | Prompted only when the link was made for another named driver, the change is on the earliest open trip, and nobody else is on the road with the link. A link made before any driver was set takes the new driver silently. | Otherwise the printed QR of a hired truck's casual driver, or the link of the driver on trip 1, would be killed by routine planning. |
| C18 | D13 "rate limits" | No IP-only block for a known token; photo limits per day per stops, not per 10 min. | Drivers share the depot Wi-Fi and CGNAT, and the client IP can be unknown on Railway: an IP block would lock every driver out. |

## 22. Open questions for the owner

| # | Question |
|---|---|
| Q1 | **Photo storage.** At NMWC volume, 365 days of photos is about **25 GB** in the database (and in backups). Keep 365 days, or 180 / 90? Keep 1600 px, or allow 1280 px (about half the size)? |
| Q2 | **Arabic wording** on the driver page (Appendix A): can an NMWC Arabic speaker check it before launch? |
| Q3 | **Hired trucks.** Should the dispatcher (not only the admin) add a hired truck for one day, planned only on that day? (follow-up spec) |
| Q4 | **Same-day second attempt.** When a shop opens later, should the dispatcher send the missing cases on another truck the same day? Today it is the same trip (the driver goes back and changes the result before the load is completed), or Bring forward to a later day. |
| Q5 | **No result at day end.** Keep "counts as delivered and listed", or require a result for every stop before a load can be Completed? |
| Q6 | **Photo for Delivered.** Required by default (yes). Is a Delivered recorded by the dispatcher without a photo acceptable? (Built: allowed, flagged "no photo".) |
| Q7 | **Cash customers.** Do drivers collect payment? The page shows no amounts (as the driver sheet); "Payment issue" is a reason. |
| Q8 | **Corrections.** Should a correction of a result after the load is Completed be limited to SUPERVISOR, or stay with every dispatcher (PLANNER)? |
| Q9 | **Positions (answered by default, confirm).** Built: positions, IPs and browser ids of driver events are erased after **90 days** (an admin setting, at most the photo retention); distances are kept for the KPIs and the pin check. Is 90 days right for NMWC? |
| Q10 | **Ayun.** Which key matches an Ayun vehicle to a truck: plate number or truck code? |
| Q11 | **Module C data.** May the retired tables (DriverShift, TruckLocation, DeliveryProof) and `Driver.accessPinHash` be dropped now? (separate clean-up PR) |
| Q12 | **Removing a planned copy.** "Undo bring forward" works only before the copy is planned. Removing an order that is already on a plan needs the order-cancel flow deferred in F20 (a CANCELLED status plus a re-plan). Build it next, so a wrong carry can always be undone in the app? |
| Q13 | **"Camera not working".** Built: a driver may save Delivered without a photo by tapping it, and it is shown as "no photo: camera failed" everywhere. Acceptable, or should it need a call to the dispatcher first? |
| Q14 | **Dispatcher phone.** Which number should the driver page's "Call dispatcher" button call (one per company, set in Settings)? Should it be per depot? |
| Q15 | **Upload grace.** Results recorded before the link expired are accepted for 72 h more. Long enough (Friday-Saturday weekend), or should it be shorter? |

## Appendix A: driver page strings (EN / AR)

| Key | EN | AR |
|---|---|---|
| title | Today's trips | رحلات اليوم |
| truck | Truck | الشاحنة |
| driver | Driver | السائق |
| hiredTruck | Hired truck | شاحنة مستأجرة |
| tripOf | Trip {n} of {m} | الرحلة {n} من {m} |
| stopsLabel | Stops: {n} | المحطات: {n} |
| casesLabel | Cases: {n} | الكراتين: {n} |
| depart | Depart {time} | المغادرة {time} |
| st.PLANNED | Planned - may still change | مخطط - قد يتغير |
| st.LOCKED | Not loaded yet | لم يتم التحميل بعد |
| st.LOADING | Loading | قيد التحميل |
| st.DISPATCHED | On the road | في الطريق |
| st.COMPLETED | Done | منتهية |
| startDeliveries | Start deliveries | ابدأ التوصيل |
| navigate | Navigate | افتح الخريطة |
| plannedArrival | Planned arrival {time} | الوصول المخطط {time} |
| unloadUntil | Unload until {time} | التفريغ حتى {time} |
| receivingHours | Receiving hours | أوقات الاستلام |
| anyTime | Any time | أي وقت |
| promised | Promised {from}-{to} | موعد متفق عليه {from}-{to} |
| notes | Notes | ملاحظات |
| partOf | Part {n} of {m} | الجزء {n} من {m} |
| carriedFrom | Carried over from {date} | منقول من {date} |
| waitingArrive | Waiting to arrive (within {m} m) | بانتظار الوصول (ضمن {m} م) |
| iArrived | I have arrived | وصلت |
| arrivedTimer | Arrived {time} · Unloading {mm} min | وصلت {time} · التفريغ {mm} د |
| doneTimer | Done {time} · {mm} min | تم {time} · {mm} د |
| delivered | Delivered | تم التسليم |
| partly | Partly delivered | تسليم جزئي |
| notDelivered | Not delivered | لم يتم التسليم |
| noResult | No result | بدون نتيجة |
| next | Next | التالي |
| reason | Reason | السبب |
| r.SHOP_CLOSED | Shop closed | المحل مغلق |
| r.CUSTOMER_REFUSED | Customer refused | العميل رفض الاستلام |
| r.NO_ONE_TO_RECEIVE | No one to receive | لا يوجد من يستلم |
| r.WRONG_LOCATION | Wrong location or could not find | الموقع خطأ أو لم أجده |
| r.NO_TIME_LEFT | No time left | لم يتبقَّ وقت |
| r.PAYMENT_ISSUE | Payment issue | مشكلة في الدفع |
| r.DAMAGED_GOODS | Damaged goods | بضاعة تالفة |
| r.NOT_ON_TRUCK | Missing from the truck | غير موجود في الشاحنة |
| r.OTHER | Other | سبب آخر |
| noteRequired | Write the reason | اكتب السبب |
| casesDelivered | Cases delivered | الكراتين المسلَّمة |
| takePhoto | Take photo | التقط صورة |
| retake | Retake | أعد التصوير |
| usePhoto | Use photo | استخدم الصورة |
| photoRequired | Photo required | الصورة مطلوبة |
| save | Save | حفظ |
| cancel | Cancel | إلغاء |
| changeResult | Change result | تغيير النتيجة |
| undo | Undo result | إلغاء النتيجة |
| backAtDepot | Back at depot | عدت إلى المستودع |
| stopsWithoutResult | Stops without a result: {n}. The dispatcher will record them. | محطات بدون نتيجة: {n}. سيسجلها مسؤول التوزيع. |
| waitingToSend | Waiting to send ({n}) | بانتظار الإرسال ({n}) |
| allSent | All sent | تم إرسال الكل |
| noSignal | No signal | لا يوجد اتصال |
| notSentYet | Not sent yet - it will be sent automatically. | لم يُرسل بعد - سيتم إرساله تلقائيًا. |
| keepOpen | Keep this page open. If the screen locks, the timer may pause. | أبقِ هذه الصفحة مفتوحة. إذا قُفلت الشاشة قد يتوقف المؤقت. |
| gpsLost | GPS signal lost | فُقدت إشارة الموقع |
| locationOff | Location is off: the timer cannot start by itself. Tap "I have arrived" at each customer. | الموقع مغلق: لن يبدأ المؤقت تلقائيًا. اضغط «وصلت» عند كل عميل. |
| notDispatched | Your dispatcher has not marked this trip as left yet. Arrival times are kept on the phone and sent once it is. Results can be recorded then. | لم يسجّل مسؤول التوزيع خروج هذه الرحلة بعد. تُحفظ أوقات الوصول في الهاتف وتُرسل بعد ذلك، ويمكن تسجيل النتائج حينها. |
| noTrips | No trips for truck {truck} on {date} (yet). | لا توجد رحلات للشاحنة {truck} في {date} حتى الآن. |
| linkInvalid | This link does not work any more. Ask your dispatcher for a new one. | هذا الرابط لم يعد يعمل. اطلب رابطًا جديدًا من مسؤول التوزيع. |
| linkExpired | This link was for {date} and has expired. | هذا الرابط كان ليوم {date} وانتهت صلاحيته. |
| carriedRefused | Already moved to {date} by the office. Call your dispatcher. | تم نقلها إلى {date} من المكتب. اتصل بمسؤول التوزيع. |
| linkDead | This link no longer works. {n} results not sent: tell your dispatcher. | هذا الرابط لم يعد يعمل. {n} نتائج لم تُرسل: أبلغ مسؤول التوزيع. |
| linkReplaced | This link was replaced by a new one. Ask your dispatcher for it. | تم استبدال هذا الرابط برابط جديد. اطلبه من مسؤول التوزيع. |
| notSentList | Not sent from this phone: {n} - show this list to your dispatcher. | لم تُرسل من هذا الهاتف: {n} - اعرض هذه القائمة على مسؤول التوزيع. |
| sendingSaved | Sending the results saved on this phone… | جارٍ إرسال النتائج المحفوظة في هذا الهاتف… |
| openInChrome | Open in Chrome | افتح في كروم |
| openInSafari | Tap ⋯ or the share icon, then Open in Safari | اضغط ⋯ أو أيقونة المشاركة ثم «فتح في سفاري» |
| copyLink | Copy link | انسخ الرابط |
| cameraNotWorking | Camera not working | الكاميرا لا تعمل |
| locationNotCaptured | Location not captured: take it again at the shop if you can | لم يُسجَّل الموقع: أعد التصوير عند المحل إن أمكن |
| arrivedWhen | Arrived at {customer} - when? | متى وصلت إلى {customer}؟ |
| now | Now | الآن |
| minAgo | {n} min ago | قبل {n} د |
| skip | Skip | تخطَّ |
| whichCustomer | Which customer are you at? | عند أي عميل أنت؟ |
| openAgainHint | When you arrive, open this page again | عند وصولك، افتح هذه الصفحة مرة أخرى |
| savedOnPhone | Saved on phone - waiting to send | محفوظ في الهاتف - بانتظار الإرسال |
| changedByOffice | Changed by office / another phone | غيّرها المكتب / هاتف آخر |
| broughtForward | Brought forward to {date} | نُقلت إلى {date} |
| callDispatcher | Call dispatcher | اتصل بمسؤول التوزيع |
| draftRestored | Your last entry was kept. | تم حفظ آخر إدخال لك. |
| lastPhotoLost | The last photo did not arrive - take it again. | لم تصل الصورة الأخيرة - التقطها مرة أخرى. |
| backAtDepotQ | Back at depot? | هل عدت إلى المستودع؟ |
| lastUpdated | Last updated {time} | آخر تحديث {time} |
| officeBanner | You are signed in to RouteIQ as {name}: results are recorded as the office. | أنت مسجّل الدخول في RouteIQ باسم {name}: تُسجَّل النتائج باسم المكتب. |
| pos.OK | Location captured | تم تسجيل الموقع |
| pos.POOR | Location not precise | الموقع غير دقيق |
| pos.DENIED | Location is off | الموقع مغلق |
| pos.TIMEOUT | No location signal | لا توجد إشارة موقع |
| pos.UNSUPPORTED | Location not available on this phone | الموقع غير متاح في هذا الهاتف |
| language | العربية / English (toggle) | English / العربية |

## Critique log

Revision 2 answers the 30-point critique of 4 Oct 2026. Each row: the verdict and a one-line reason, then where the spec changed.

| # | Critique | Sev. | Verdict | Reason | Where |
|---|---|---|---|---|---|
| 1 | A backdated `at` lets a link holder rewrite results on COMPLETED loads | high | **Accepted, with a longer bound** | After completion the link only fills gaps (stops with no result at completion), flagged late and never ticked; the bound is the upload window (§4.2) instead of 6 h, because a gap-fill can never flip a result and the queue must not lose offline results. | §8.3, §9.1 items 4-5, E10, C4, §18 |
| 2 | The per-IP bad-token throttle can lock every driver out | high | **Accepted** | Resolve first, count only unknown hashes, skip null or internal IPs, `prevTokenHash` answers 410 without counting, the page stops polling on 404/410, 429 is transient with `Retry-After`, photos capped per day; the page route needs no guard because it is now a data-free shell (§6.1). | §4.1, §4.3, §5, §6.3, §13.2, §16.2 |
| 3 | Rotating the key does not kill old links: resolve never checks `keyId` | medium | **Accepted (optional start-up rehash rejected)** | Resolve answers 410 `LINK_REPLACED` on a `keyId` mismatch; a start-up rehash is not needed because ensure already rehashes when the dialog or PDF reopens the link. | §4.1, §4.3, §18 |
| 4 | The token leaks through Sentry tracing, Railway logs, wa.me and server-rendered HTML | medium | **Accepted** | Token only in the landing path, a header on token-free API paths, photos as blobs, a data-free shell, `tracesSampler` + `beforeSendTransaction` + `beforeBreadcrumb` in all four Sentry inits; Railway logs, wa.me and previews listed as accepted risks. | §4.1, §5, §6.1, §12.3, §16.1, C12 |
| 5 | Audit identity names the wrong driver; a dispatcher using the link is indistinguishable | medium | **Accepted** | IP and a random browser id on every event and photo, an actor that says whom the link was made for, a signed-in session turns writes into the office's (or refuses them), "used on N phones" in the dialog, and the quick add asks before reusing a phone with another name. | §3, §4.3, §5, §14, §16.4 |
| 6 | Driver locations and casual-driver contacts are kept forever; the notice states no retention | medium | **Accepted** | `locationRetentionDays` (default 90) erases positions, IPs and device ids but keeps distances; the notice names the company, purpose, retention and whom to ask; phone data is purged after the upload window; idle daily drivers are hidden and their phone erased; backups documented as the real horizon. | §3, §12.4, §13.1, §16.3, Q9 |
| 7 | Photo retention is keyed on the client-supplied `takenAt` | low | **Accepted** | Purge on server `receivedAt` with its index; `takenAt` clamped, the raw value kept in `rawTakenAt` (EXIF time stays in `exifTakenAt`). | §3, §12.2, §12.4, §18 |
| 8 | Uploaded JPEG bytes are stored and served with their metadata | low | **Accepted** | `stripJpeg` keeps only the image segments (plus APP0/APP14) and drops EXIF, thumbnails and COM; hash and idempotency use the stripped bytes. | §12.2, §16.1, §18 |
| 9 | The server's automatic-arrival re-check trusts client positions | low | **Accepted** | The false claim is corrected, plausibility flags set `timingSuspect`, flagged visits leave measured times, the on-time KPI and the pin check, and Ayun is named as the cross-check. | §3, §8.3, §11, §16.1, §17 |
| 10 | Idempotency keys are client-chosen and tenant-wide, so they can be squatted or collide | low | **Accepted** | Lowercase UUIDs only, server-side namespaces (`dl:`, `dlphoto:`, `disp:`, `ayun:`), and a duplicate only for the same link; otherwise `INVALID` with nothing echoed. | §3, §8.1, §8.3, §12.2, §13.3, §18 |
| 11 | The chained-arrival rule fires after a GPS or visibility gap and backdates the next arrival | high | **Accepted** | Chaining needs pins within R + 50 m, no gap and no OUT fix since the result; otherwise a gap departure and a normal next arrival; the server ignores `chained` between distant pins. | §7.3, §7.4 (cases 15-17), §8.3 |
| 12 | Arrivals and departures the page never saw are counted as auto-timed | high | **Accepted** | Observed vs. resumed arrivals, `arrivalObserved` and `autoBasis` on the visit, automatic timing only from observed events, the "Arrived when?" chips, the Navigate hint, and only observed arrivals in the KPIs. | §3, §6.3, §7.3, §8.4, §11, C14 |
| 13 | With photo proof required, an in-app browser or a failed camera blocks Delivered | high | **Accepted** | WebView detection with Open in Chrome / Safari, a "Camera not working" exception shown everywhere, and the new PDF caption. | §6.1, §6.3, §6.6, §8.2, C15, Q13 |
| 14 | Opening the camera on low-memory phones reloads the page and loses photo, draft and timer | high | **Accepted** | Per-stop drafts and draft photos in IndexedDB, the tracker rebuilt from the server and unsent items, tracking restarted when permission is granted, a downscaled decode, and the case in Part 2's acceptance. | §6.3, §7.3, §12.1, §13.1, §20 |
| 15 | No offline page load and no local display of unsent results | high | **Accepted (no special header)** | A `/d/`-scoped service worker (network-first shell, cache-first hashed statics, never the API), the last manifest in IndexedDB, and `applyQueued` with "Saved on phone" and "Changed by office"; `Service-Worker-Allowed` is not needed because `/d/` is narrower than the worker's own scope. | §6.2, §13.1, §13.4, §13.5, C10 |
| 16 | Rate limits and link expiry can strand queued data or block every driver at the depot | high | **Accepted** | 429 transient with `Retry-After`, the per-day photo cap with 60-per-10-min bursts, a 72 h upload-only grace, only unknown hashes counted, and no IP block for a token that resolves. | §4.2, §5, §13.2, §16.2, C13, C18 |
| 17 | Mixed clock sources can disable the timer or shift times | medium | **Accepted** | `Fix.at` = `Date.now()` in the callback, `position.timestamp` only as `gpsAt`, one skew correction for all device times, photo `takenAt` = capture time, EXIF time only for the old-photo check with its offset or the tenant zone. | §7.1, §7.4 (case 22), §12.1, §13.3, §18 |
| 18 | `pickStop` assigns arrivals to the wrong stop (multi-trip days, shared pins, traffic, depot) | medium | **Accepted** | Only the current trip is tracked, 20 s for the expected stop and 90 s for others, "Which customer?" when two pins are inside together, and no automatic arrival near the depot. | §7.3, §7.4 (cases 10, 19-21, 25), §17 |
| 19 | A late Dispatch click leaves the driver page dead and loses the first stops' timing | medium | **Accepted** | Start deliveries from 30 min before departure on any open load, held automatic events sent after Dispatch, a Call dispatcher button (new `dispatcherPhone` setting), and the late-dispatch note on the plan and day screens. | §3, §6.3, §6.5, §7.3, §13.2, Q14 |
| 20 | Photo location is usually missing or coarse, and old gallery photos can pass as proof | medium | **Accepted** | A high-accuracy fix when the camera returns (Save never waits), `positionStatus` on the photo, "Location not captured" on the thumbnail, the old-photo check on EXIF or file time against arrival or dispatch, and honest docs on EXIF GPS. | §3, §11.2, §12.1, §12.2 |
| 21 | After a refused correction the dispatcher cannot fix the copy: an order cannot be removed | high | **Accepted in part** | "Undo bring forward" is built for a copy no plan refers to; a planned copy cannot be deleted because `RouteAssignment.orderId` is ON DELETE RESTRICT and every version keeps its rows (F12), so the refusal says so, the change is kept as a `CARRY_CONFLICT` that warns on the copy and at Lock, and the cancel flow is Q12. | §1 F12, §5 #15, §9.3 E6, §9.4, §16.4, C16, Q12 |
| 22 | Today's not-delivered orders are ticked while the truck is still out | high | **Accepted** | Today's group is ticked only when every visit behind the shortfall is final (Completed or Back at depot); the stop shows "Brought forward" and hides Change result once carried. | §8.6, §8.7, §9.1, §9.3 E1/E1b, C6 |
| 23 | Split orders: "confirmed" ignores parts with no result; later results on them are lost | medium | **Accepted** | Confirmed needs every left part to have a result; the carry basis is stored on the copy and in the audit; only changes that shrink carried cases are refused; a new shortfall is stored and listed as information. | §3, §8.3, §8.6, §9.1 items 1, 4, 10, 11, §9.3 E3b, §9.4 |
| 24 | The "Reissue link?" prompt fires on a first driver entry and on trip 2 while trip 1 is out | medium | **Accepted, with a change** | Prompt conditions and the silent first driver as proposed, [Keep link] default with the consequence spelled out; manual Reissue is **not** refused while a load is on the road (it asks first), because a leaked QR must be stoppable at once. | §4.3, §10.2, C17, §18 |
| 25 | Arrivals before Dispatch are dropped, and arrivals can land on an earlier trip's open stop | medium | **Accepted** | Same fix as 18 and 19: the current trip only, held events before Dispatch, and `LOAD_NOT_DISPATCHED` transient for ARRIVE and DEPART. | §7.3, §8.1, §8.3, §13.2 |
| 26 | Measured unloading counts waiting for opening hours and breaks | medium | **Accepted** | `autoServiceMinutes` from max(arrival, window start), break-overlapping visits and outliers above plan + 60 excluded, an early arrival that waits counted inside the window, and "planned" from `effectiveAttrs`. | §3, §8.4, §11.1, §11.4, §18 |
| 27 | The no-result list and KPIs fill with old stops on deploy and miss returned trucks | medium | **Accepted** | `TenantConfig.outcomesSince` (set at migration) scopes the list and KPIs; today's list includes returned and overdue DISPATCHED loads; the panel groups per truck. | §3, §8.7, §9.1 item 7, §10.3, §11.4 |
| 28 | Retrying after P2002 inside one PostgreSQL transaction cannot work | medium | **Accepted** | Advisory locks before read-and-create (driver link, daily-driver code), the idempotency check moved under the outcome-day lock, P2002 answered from a fresh read outside the transaction, and a per-truck ensure in the PDF route with a placeholder on failure. | §4.3, §6.6, §8.3, §13.3, §14, §18 |
| 29 | Results queued on the phone are stuck for good once the link expires | low | **Accepted (first option)** | The 72 h upload-only grace for actions with `at` before expiry; the "Reissue for upload" alternative is not needed. | §4.2, §13.2, C13 |
| 30 | The WhatsApp link cannot be fetched at click time, and a revoked link still prints | low | **Accepted** | Links load with the plan (GET #5) so the `wa.me` href stays synchronous; without a link the action opens the dialog; revoked links print "Driver link stopped" and leave the WhatsApp line out. | §5 #5, §6.5, §6.6, §18 |

## Review of 4 Oct 2026 (after Part 3): what changed

Fixed on the branch `delivery-outcome-driver-page`, each with a failing test first where it could be tested without a DOM:

- **Security.** The daily-driver quick add reactivates daily drivers only: an inactive regular driver is not offered (`PHONE_BELONGS_TO`) and `useExisting` naming one answers 409 `DRIVER_INACTIVE`. The driver flood controls of §16.2. Driver-link audit rows keep no IP or phone id (§16.4). A load closed by a signed-in user is their row.
- **Carry (§9).** Every driver action and photo takes the outcome-day lock before it reads the load, the stop and the visit, and `carryBases` reads the orders' `carriedToOrderId` again under the lock (the office path too: a Bring forward racing a result change can no longer slip past the basis rule). Undo is refused `COPY_CARRIED_AGAIN` for a copy that was brought forward again, and such a copy is not offered. "Had a result at completion" is the effective result then (a cleared one is none). The Bring forward toast says today's recorded not-delivered orders need nothing on today's plan.
- **Field (§7, §12, §13).** OUT is accuracy-aware without a bound and a coarse NEAR fix is not "seen outside"; after a gap a departure needs two outside fixes 20 s apart (`gapConfirmMs`). After a reload the tracker waits for the queue (`ready`). "Back at depot?" belongs to its trip. A changed result needs no new photo when the stop has one (client and server). Each send's results are laid into the manifest before its items leave the queue; a stale manifest is dropped. The camera input is clicked inside the tap. Arabic and Persian digits count in the Partly stepper. The photo position is asked when the file arrives. Every request has a time limit (30 s; photos 90 s). "Taken earlier" is decided on the server clock (file time skew-corrected, an EXIF time without an offset ignored).
- **Office (§10, §11).** Office Arrived / Left: the newest entry wins and replaces the phone's, Left needs an arrival, an office result time is never a Left; the dialog shows the stored times and sends only a changed box. The actuals Excel's actual unloading is the plan screen's figure, with a range picker on the Deliveries card. A visit keeps `timingSuspect` after the location purge. The pin check groups in one pass; measured times read each customer's own newest 20 timed visits. The pin-check wording says "at least 2 of the last 3 visits" (one wrong-location report alone does not flag).
- **Load.** Indexes `StopEvent(kind, receivedAt)`, `StopEvent(tenantId, receivedAt)`, `DeliveryPhoto(driverLinkId)` (same migration). The returned-loads sweep runs at most every 10 min, newest first, dropping truck-days whose load is no longer DISPATCHED in one query. The photo daily cap is counted before the outcome-day lock. The plan screen and the day screen do not re-read the results on a running search's polls. The links of a plan and the PDF's links are read in one batch. Delete deactivates a truck that a driver link or a stop visit names.

## Second review of 4 Oct 2026: what changed

Fixed on the branch `delivery-outcome-driver-page`, each with a failing test first:

- **Photo proof of a changed result (§8.2).** The proof is the set of photo keys named by the driver's earlier Delivered or Partly results at the stop (`proofPhotoKeys`), counted whether or not the photos have arrived. The server and the phone use the same evidence: the server reads the visit's OUTCOME events; the phone adds `StopResult.proofPhotos` and the keys of its queued Delivered / Partly results. A change sent in the same batch as the first result, while its photo still waits for its position, or while the photo upload backs off, is accepted (before, it was refused `PHOTO_REQUIRED` and dropped, and the missing cases never reached Bring forward). A photo taken for a Not delivered (the closed shutter) is no proof of a delivery made on a return visit. At 3 such photos the stop is full, so the only way to save Delivered is *Camera not working* (recorded as such).
- **Stop timer (§7.3).** The two outside fixes that confirm a departure after a gap must fall in the same visible period: every new gap (Retake, the lock screen, no fix for 30 s) clears the first one. Two camera gaps each followed by one bad fix no longer end the stop and start a false second arrival.
- **Office (§10).** A result recorded with Record outcome is shown at once on the plan and on the day's Deliveries card, also during a running search (`readResultsNow`): the plan reads its results before the plan's own answer, and the day's loads ask with `deliveries=1` until an answer carrying them is shown.
- **Privacy (§16.3).** The browser ids on the driver links (`DriverLink.devicesJson`) are blanked by the location-retention sweep for links of a delivery date older than the retention; "used on N phones" keeps its count and times.
- **Weak signal (§12, §13).** A retry of a photo already stored answers `duplicate`, also once the daily cap is reached. The photo upload limit grows with the size (30 s + size at 4 KB/s, at least 90 s, at most 10 min), so a large photo on an EDGE uplink still arrives.
