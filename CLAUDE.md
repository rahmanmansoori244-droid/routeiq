> **Read this first (Sep 2026).** This file is the ORIGINAL May 2026 SaaS build specification and is kept for history. The system that is live today is the NMWC daily dispatch planner, described in [`docs/PROJECT_HANDBOOK.md`](./docs/PROJECT_HANDBOOK.md) (where everything is, process flow, optimizer logic, how to run/test/deploy, history, and a guide for AI code reviewers). Where this spec disagrees with the handbook, the `docs/` folder or the code, **the handbook, the docs and the code win**. For example, receiving time windows and split deliveries are implemented, although this spec lists them as out of scope for v1.

# RouteIQ — Multi-Tenant Route Optimization Platform
## Complete Build Specification (v1.3)

> **This document is the single source of truth for the build. Save it as `CLAUDE.md` in the repo root. Claude Code reads this at the start of every session and follows it phase by phase. Do not skip phases. Do not invent features not listed here. When the spec is ambiguous, ask the user — do not guess.**

### v1.3 update notes (implementation-readiness review)
This version closes the remaining build-blocking gaps before handing the spec to Claude Code:

**Correctness & job lifecycle:**
- `RunJob` now supports multiple retry attempts per `RunPlan` instead of incorrectly using `runId @unique`.
- `RunStatus` now includes `FAILED`, and failed optimization jobs set the parent run to `FAILED`.
- `RunJob` stores `requestJson` and `responseJson` so failed or suspicious solver behavior can be replayed and debugged.

**Operations:**
- v1 deployment explicitly requires exactly one `routeiq-web` Railway replica because the lightweight in-memory `inflight` map is not safe under horizontal scaling.
- Redis/BullMQ locking remains a v2 requirement before scaling beyond one web instance.

**Product & audit:**
- Manual map adjustment now has explicit insertion/resequencing rules to avoid duplicate route sequence conflicts.
- Optimization and route-planning events now have required audit action names: `OPTIMIZE_STARTED`, `OPTIMIZE_SUCCEEDED`, `OPTIMIZE_FAILED`, `SCENARIO_CHOSEN`, `BASELINE_UPLOADED`, and `ROUTE_MANUALLY_CHANGED`.
- When Haversine is used, every UI, export, API label, dashboard KPI, and report must say **Estimated km** instead of plain **Km**.

### v1.2 update notes (from multi-perspective review)
This version fixes one critical correctness bug and tightens security, operations, and acceptance criteria:

**Correctness:**
- **Disjunction penalty formula fixed.** v1.1 had penalty `100000 × priority` which was inverted — priority 1 (highest) would have been the easiest to drop. Now: `1_000_000 × (6 − priority)`, so priority 1 customers get the largest drop penalty (5,000,000) and priority 5 customers the smallest (1,000,000).
- **Solver time limit auto-scales** with stop count: `min(max(30, stops × 0.05), 120)` seconds. Tenant config caps still apply.
- **`MAX_UTILIZATION` mode clarified** — it influences scenario weighting, not a separate solver run. Documented in section 7.

**Security:**
- Rate limiting extended beyond `/api/auth/*` to `/api/orders/upload` and `/api/runs/{id}/optimize`.
- File upload hardened: content-type validation, max 50,000 rows per file, max 10 MB, xlsx parsed with bomb-defense limits.
- Password reset tokens: 24h lifetime, single-use, 32-byte cryptographically random, hashed before storage.
- `tenantDb()` wrapper enforcement specified as an automated test suite, not just a lint rule.

**Operations:**
- Railway internal URL corrected to `*.railway.internal` pattern.
- `/api/health` endpoint added for the web service (was solver-only).
- PostGIS setup made explicit in the deploy section.
- Stuck `RunJob` janitor specified (auto-fail at >5 min RUNNING).

**Product:**
- Success criterion now has a numeric target: ≥10% reduction in trucks used OR ≥15% reduction in estimated distance vs manual baseline, validated on at least 3 NMWC days.
- Map manual adjustment standardized on context-menu pattern (drag-and-drop removed — unreliable on Mapbox).
- Per-region distance multiplier flagged as v2 work via TODO comment in schema.

**Carried forward from v1.1:**
- Time windows out of v1, stored as metadata only.
- `UploadBatch` first-class model with traceability and bulk-delete safety.
- `branchKey` normalization fixes Postgres NULL-uniqueness footgun.
- `RunJob` polling pattern decouples optimization from browser request lifecycle.
- Haversine distances labeled estimated with configurable multiplier.
- `ManualBaseline` model for proving optimized-vs-manual savings.
- `UnservedOrder` with structured reason codes.

---

## 0. How to use this document

1. Create a new empty repo. Save this file as `CLAUDE.md` at the root.
2. Start Claude Code in the repo and say: **"Read CLAUDE.md and execute Phase 0. Stop and confirm with me before starting Phase 1."**
3. Review each phase's deliverable. Only move to the next phase when the current one is deployed and working.
4. The first tenant is NMWC (National Mineral Water Company, Oman). Real NMWC data is the validation set.

---

## 1. Mission and constraints

### What we are building
A multi-tenant SaaS web platform that takes daily sales orders and produces optimized truck routes for FMCG / beverage / water / wholesale distribution companies. The first customer is NMWC Oman. The architecture must support additional tenants without rewriting.

### Success criteria for v1
- A logistics planner can log in, upload a daily order file, click optimize, see 3 scenarios, pick one, and export route sheets in under 5 minutes.
- **Quantitative target**: optimized plan achieves at least one of the following vs the manual baseline, validated on at least 3 different NMWC operating days: ≥10% reduction in trucks used, OR ≥15% reduction in estimated total distance, OR ≥10% increase in average truck utilization without increasing trucks. Failure to hit any of these on the chosen NMWC pilot dataset is a v1 failure, not a feature-gap — the optimizer must be re-tuned before launch.
- A second tenant can be onboarded by an admin in under 30 minutes without touching code (validated by a stopwatched dry-run with a fresh tenant slug, seeded CSVs, and the onboarding wizard).

### Out of scope for v1 (do not build)
- Driver mobile app (Phase 7+)
- Real-time GPS tracking and reconciliation (Phase 7+)
- Time windows on customer deliveries (v2; v1 stores optional preferred-time metadata only and does not enforce it in optimization)
- Multi-depot routing in a single run (Phase 6 — v1 runs one depot at a time)
- Split deliveries, pickup-and-delivery, dynamic rerouting (v2+)
- ERP/Oracle direct integration (v2 — Excel upload only in v1)
- AI assistant module (v2)
- Stripe billing wiring (structure ready, not wired)
- Arabic translation of UI (RTL-ready structure, but English-only copy in v1)

### Non-negotiable principles
- Multi-tenant from line one. Every business table has `tenantId`. Every query is tenant-scoped via middleware.
- Type-safe end to end. TypeScript everywhere. Zod for validation. Prisma for DB.
- Server-side rendering for data pages, client components only where interactivity demands it.
- No feature flags for v1 — ship the spec, nothing more, nothing less.
- Every destructive action (delete, override, finalize) writes to AuditLog.

---

## 2. Tech stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Web framework | Next.js 14 App Router + TypeScript | One repo, server components, easy deploy |
| ORM | Prisma | Type-safe queries, migrations, schema as code |
| DB | PostgreSQL 16 + PostGIS extension | Geospatial in v2, JSON config in v1 |
| Auth | NextAuth.js (Auth.js v5) | Credentials provider + tenant resolution |
| Styling | Tailwind CSS + shadcn/ui | Fast, accessible, customizable |
| Forms | React Hook Form + Zod | Type-safe forms with schema validation |
| Maps | Mapbox GL JS | Better Arabic / RTL support than Google free tier |
| Charts | Recharts | Already proven in your stack |
| Icons | Lucide React | Clean, consistent |
| File parsing | SheetJS (xlsx), Papa Parse (csv) | Standard, browser + server |
| Exports | ExcelJS (xlsx out), @react-pdf/renderer (pdf) | Server-side generation |
| Optimization | Python 3.11 + FastAPI + OR-Tools | Separate service, called by Next.js API |
| Job queue | Lightweight `RunJob` table + polling in v1; no external queue | Add BullMQ/Redis in v2 when needed |
| Hosting | Railway for both services + Postgres | Matches existing stack, single bill |
| Monitoring | Sentry for errors, Railway logs for now | Add Datadog/Posthog in v2 |

### Repository structure
```
/routeiq
  /apps
    /web                    # Next.js app
      /app
      /components
      /lib
      /prisma
      package.json
    /solver                 # Python OR-Tools service
      main.py
      solver.py
      models.py
      requirements.txt
      Dockerfile
  /packages
    /shared-types           # Shared TS types between web and (eventually) clients
  pnpm-workspace.yaml
  turbo.json
  README.md
  CLAUDE.md                 # This file
```

Use pnpm + Turborepo. Single deploy target per app on Railway.

---

## 3. Multi-tenancy architecture

### Model
**Shared database, shared schema, tenant_id on every business row.** Simple to operate at v1 scale (≤50 tenants).

### Tenant resolution
- URL pattern: `app.routeiq.io/t/{tenantSlug}/...` — path-based for v1 (no DNS work).
- Slug resolved in middleware: `app/middleware.ts` extracts slug, looks up tenant, attaches `tenantId` to a request header `x-tenant-id`. Slug must also match the session's `tenantId` — mismatch returns 404 (not 403), to avoid leaking tenant existence.
- Server components and API routes read `tenantId` from `getCurrentTenant()` helper in `lib/tenant.ts` — which reads from the validated session, not from the URL header (defense in depth).
- Every Prisma query MUST go through `tenantDb(tenantId)` — a wrapper that injects `where: { tenantId }` on every read and `data: { tenantId }` on every write. Direct `prisma.x.findMany()` is forbidden outside of platform-admin routes.
- Enforcement: a dedicated Vitest suite (`tests/tenant-isolation.spec.ts`) seeds two tenants with overlapping-looking IDs and asserts that every Prisma model accessed through `tenantDb(tenantA)` returns zero rows belonging to tenant B. CI blocks merge if this suite fails or if a new model is added to the schema without a corresponding test entry. A lint rule (custom ESLint plugin) provides developer-time feedback but is not the primary enforcement mechanism.

### Tenant onboarding flow
1. `/signup` — collects company name, slug, admin email, password, country, default currency, default units (cases / cartons / pallets / kg).
2. Creates `Tenant`, `User` (TENANT_ADMIN role), and a default `TenantConfig` row.
3. Redirects to `/t/{slug}/onboard` — three-step wizard: add first depot, add first truck, add first customer (or upload customer CSV).
4. After onboarding, lands at `/t/{slug}/` dashboard.

### Platform admin
- `/admin` route (super-admin only, gated by email allowlist env var `SUPER_ADMIN_EMAILS`).
- Lists tenants, can suspend, can view usage. v1: read-only except suspend toggle.

---

## 4. Auth and roles

### Roles
| Role | Scope | Permissions |
|---|---|---|
| SUPER_ADMIN | Platform | Everything across all tenants |
| TENANT_ADMIN | Tenant | All within tenant including users, billing, settings |
| PLANNER | Tenant | All operational actions: upload, optimize, dispatch, manual adjust |
| SUPERVISOR | Tenant | Same as planner + can approve manual overrides |
| VIEWER | Tenant | Read-only access to dashboard, routes, reports |

(Driver role is Phase 7+, not in v1.)

### Implementation
- NextAuth credentials provider + bcrypt for password hashing (cost factor 12).
- Session stores `userId`, `tenantId`, `role`. Tenant ownership re-validated server-side on every request — never trusted from URL path alone.
- Authorization helper `requireRole(role)` in server actions and API routes.
- Middleware blocks unauthenticated access to all `/t/*` routes.
- Password reset:
  - Use Resend (default) or Postmark — env-configurable.
  - Token: 32 bytes from `crypto.randomBytes`, base64url-encoded.
  - Store SHA-256 hash of the token in DB, never the raw token.
  - 24-hour expiry, single-use (delete on consumption).
  - Throttle: max 3 reset requests per email per hour.

---

## 5. Complete data model (Prisma schema)

```prisma
// prisma/schema.prisma
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }
generator client { provider = "prisma-client-js" }

enum Role {
  SUPER_ADMIN
  TENANT_ADMIN
  PLANNER
  SUPERVISOR
  VIEWER
}

enum CapacityUnit {
  CASES
  CARTONS
  PALLETS
  KG
}

enum OptimizationMode {
  MIN_TRUCKS
  MIN_DISTANCE
  MIN_COST
  BALANCED
  MAX_UTILIZATION
}

enum OrderStatus {
  UPLOADED
  VALIDATED
  ASSIGNED
  DISPATCHED
  DELIVERED
  FAILED
  UNSERVED
}

enum RunStatus {
  DRAFT
  OPTIMIZING
  READY
  FAILED
  DISPATCHED
  ARCHIVED
}

enum PaymentType {
  CASH
  CREDIT
  PREPAID
}

enum UploadBatchStatus {
  PARSED
  VALIDATED
  CONFIRMED
  REJECTED
  DELETED
}

enum RunJobStatus {
  QUEUED
  RUNNING
  SUCCEEDED
  FAILED
  CANCELLED
}

enum UnservedReasonCode {
  MISSING_COORDINATES
  EXCEEDS_TRUCK_CAPACITY
  NO_AVAILABLE_TRUCK
  SHIFT_TIME_LIMIT
  INVALID_CUSTOMER
  SOLVER_DROPPED_LOW_PRIORITY
  INFEASIBLE_ROUTE
  UNKNOWN
}

enum DistanceProvider {
  HAVERSINE
  MAPBOX_MATRIX
}

model Tenant {
  id          String   @id @default(cuid())
  slug        String   @unique
  name        String
  country     String
  currency    String   @default("OMR")
  primaryUnit CapacityUnit @default(CASES)
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())
  config      TenantConfig?

  users     User[]
  depots    Depot[]
  trucks    Truck[]
  drivers   Driver[]
  regions   Region[]
  customers Customer[]
  products  Product[]
  uploadBatches UploadBatch[]
  orders    Order[]
  runs      RunPlan[]
  runJobs   RunJob[]
  manualBaselines ManualBaseline[]
  audits    AuditLog[]
}

model TenantConfig {
  id                       String  @id @default(cuid())
  tenantId                 String  @unique
  tenant                   Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  avgSpeedKmh              Float   @default(40)        // for time matrix
  distanceProvider         DistanceProvider @default(HAVERSINE)
  distanceMultiplier       Float   @default(1.30)      // v1 adjustment for straight-line estimates
  // TODO v2: replace single tenant-wide multiplier with per-region overrides (RegionDistanceConfig).
  // City centers (Muscat) typically need ~1.4-1.5, highway regions (Duqm) ~1.1-1.2.
  // v2 should auto-calibrate from ManualBaseline.manual_distance_km vs Haversine-estimated distance.
  labelEstimatedDistances  Boolean @default(true)      // required when Haversine is used
  driverShiftMaxMinutes    Int     @default(540)       // 9 hours
  returnToDepot            Boolean @default(true)
  defaultServiceTimeMin    Int     @default(10)
  costPerKmDefault         Float   @default(0.15)
  fixedTruckCostPerDayDefault Float @default(20)
  latePenaltyPerMin        Float   @default(0.5)
  underutilizationPenalty  Float   @default(0)
  solverTimeLimitSeconds   Int     @default(30)        // base; auto-scales with stop count, see section 7
  weightObjectiveTrucks    Float   @default(1000)      // for weighted-sum objective
  weightObjectiveDistance  Float   @default(1)
  weightObjectiveCost      Float   @default(0)
  weightObjectiveBalance   Float   @default(0)
  weightObjectiveUtilization Float @default(0)         // used by MAX_UTILIZATION mode weighting
}

model User {
  id        String   @id @default(cuid())
  tenantId  String?  // nullable only for SUPER_ADMIN role; all other roles must have a tenant
  tenant    Tenant?  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  email     String   @unique
  passwordHash String
  name      String
  role      Role     @default(VIEWER)
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  uploadBatches UploadBatch[]
  runJobs   RunJob[]
  manualBaselines ManualBaseline[]
  audits    AuditLog[]
  routeAssignmentLocks RouteAssignment[] @relation("RouteAssignmentLockedBy")
  @@index([tenantId])
}

model Depot {
  id        String   @id @default(cuid())
  tenantId  String
  tenant    Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  code      String
  name      String
  lat       Float
  lng       Float
  address   String?
  active    Boolean  @default(true)
  trucks    Truck[]
  regions   Region[]
  runs      RunPlan[]
  @@unique([tenantId, code])
  @@index([tenantId])
}

model Truck {
  id                  String  @id @default(cuid())
  tenantId            String
  tenant              Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  depotId             String
  depot               Depot   @relation(fields: [depotId], references: [id])
  code                String
  description         String?
  capacityCases       Int     @default(0)
  capacityWeightKg    Float   @default(0)
  capacityVolumeL     Float   @default(0)
  fixedCostPerDay     Float   @default(0)
  costPerKm           Float   @default(0)
  active              Boolean @default(true)
  routes              RouteAssignment[]
  @@unique([tenantId, code])
  @@index([tenantId, depotId])
}

model Driver {
  id        String  @id @default(cuid())
  tenantId  String
  tenant    Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  code      String
  name      String
  phone     String?
  active    Boolean @default(true)
  @@unique([tenantId, code])
  @@index([tenantId])
}

model Region {
  id        String  @id @default(cuid())
  tenantId  String
  tenant    Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  depotId   String?
  depot     Depot?  @relation(fields: [depotId], references: [id])
  code      String
  name      String
  customers Customer[]
  @@unique([tenantId, code])
  @@index([tenantId])
}

model Customer {
  id              String   @id @default(cuid())
  tenantId        String
  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  regionId        String?
  region          Region?  @relation(fields: [regionId], references: [id])
  code            String
  name            String
  branchCode      String?
  branchKey       String   @default("__MAIN__") // normalized: blank/null branchCode becomes __MAIN__
  address         String?
  lat             Float?
  lng             Float?
  geocodeConfidence String? // HIGH | MEDIUM | LOW | MISSING
  priority        Int      @default(3)   // 1=highest, 5=lowest
  avgServiceTimeMin Int    @default(10)
  paymentType     PaymentType @default(CREDIT)
  accessNotes     String?
  active          Boolean  @default(true)
  orders          Order[]
  @@unique([tenantId, code, branchKey])
  @@index([tenantId, regionId])
}

model Product {
  id              String  @id @default(cuid())
  tenantId        String
  tenant          Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  code            String
  name            String
  weightPerCaseKg Float   @default(0)
  volumePerCaseL  Float   @default(0)
  active          Boolean @default(true)
  orderLines      OrderLine[]
  @@unique([tenantId, code])
  @@index([tenantId])
}

model UploadBatch {
  id              String   @id @default(cuid())
  tenantId        String
  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  fileName        String
  fileType        String
  uploadedById    String
  uploadedBy      User     @relation(fields: [uploadedById], references: [id])
  uploadedAt      DateTime @default(now())
  deliveryDate    DateTime? @db.Date
  status          UploadBatchStatus @default(PARSED)
  totalRows       Int      @default(0)
  validRows       Int      @default(0)
  errorRows       Int      @default(0)
  warningRows     Int      @default(0)
  validationJson  Json?
  orders          Order[]
  @@index([tenantId, uploadedAt])
}

model Order {
  id                       String   @id @default(cuid())
  tenantId                 String
  tenant                   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  customerId               String
  customer                 Customer @relation(fields: [customerId], references: [id])
  deliveryDate             DateTime @db.Date
  totalCases               Int      @default(0)
  totalWeightKg            Float    @default(0)
  totalVolumeL             Float    @default(0)
  totalServiceTimeMin      Int      @default(10)
  priority                 Int      @default(3)
  paymentCollectionAmount  Float    @default(0)
  notes                    String?
  status                   OrderStatus @default(UPLOADED)
  uploadBatchId            String?
  uploadBatch              UploadBatch? @relation(fields: [uploadBatchId], references: [id], onDelete: SetNull)
  uploadedAt               DateTime @default(now())
  lines                    OrderLine[]
  assignments              RouteAssignment[]
  unservedRecords          UnservedOrder[]
  manualBaselineAssignments ManualBaselineAssignment[]
  @@index([tenantId, deliveryDate])
  @@index([tenantId, customerId])
}

model OrderLine {
  id        String  @id @default(cuid())
  orderId   String
  order     Order   @relation(fields: [orderId], references: [id], onDelete: Cascade)
  productId String
  product   Product @relation(fields: [productId], references: [id])
  cases     Int
  @@index([orderId])
}

model RunPlan {
  id                String   @id @default(cuid())
  tenantId          String
  tenant            Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  depotId           String
  depot             Depot    @relation(fields: [depotId], references: [id])
  runDate           DateTime @db.Date
  status            RunStatus @default(DRAFT)
  optimizationMode  OptimizationMode @default(BALANCED)
  chosenScenarioId  String?
  totalOrders       Int      @default(0)
  unservedCount     Int      @default(0)
  createdById       String
  createdAt         DateTime @default(now())
  finalizedAt       DateTime?
  scenarios         ScenarioResult[]
  routes            RouteAssignment[]
  currentJobId      String?  // latest/active RunJob id; scalar to avoid cyclic required relations
  jobs              RunJob[]
  manualBaselines   ManualBaseline[]
  @@index([tenantId, runDate])
  @@index([tenantId, currentJobId])
}

model ScenarioResult {
  id              String   @id @default(cuid())
  runId           String
  run             RunPlan  @relation(fields: [runId], references: [id], onDelete: Cascade)
  name            String   // "Min Trucks" | "Min Distance" | "Balanced"
  trucksUsed      Int
  totalDistanceKm Float
  totalTimeMin    Int
  totalCost       Float
  avgUtilizationPct Float
  unservedCount   Int
  detailsJson     Json     // full route breakdown returned by solver
  unservedOrders UnservedOrder[]
  createdAt       DateTime @default(now())
  @@index([runId])
}

model RouteAssignment {
  id                    String   @id @default(cuid())
  runId                 String
  run                   RunPlan  @relation(fields: [runId], references: [id], onDelete: Cascade)
  truckId               String
  truck                 Truck    @relation(fields: [truckId], references: [id])
  orderId               String
  order                 Order    @relation(fields: [orderId], references: [id])
  sequenceInTruck       Int
  plannedArrivalMin     Int      // minutes from depot departure
  plannedDistanceFromPrevKm Float
  plannedLoadCases      Int
  lockedByUserId        String?
  lockedBy              User?    @relation("RouteAssignmentLockedBy", fields: [lockedByUserId], references: [id], onDelete: SetNull)
  manualOverrideReason  String?
  @@unique([runId, truckId, sequenceInTruck])
  @@index([runId, truckId])
}

model RunJob {
  id          String   @id @default(cuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  runId       String
  run         RunPlan  @relation(fields: [runId], references: [id], onDelete: Cascade)
  attemptNo   Int      @default(1)
  status      RunJobStatus @default(QUEUED)
  progressPct Int      @default(0)
  message     String?
  requestJson Json?    // exact solver request for replay/debug/support
  responseJson Json?   // exact solver response when available
  createdById String
  createdBy   User     @relation(fields: [createdById], references: [id])
  createdAt   DateTime @default(now())
  startedAt   DateTime?
  finishedAt  DateTime?
  errorJson   Json?
  @@unique([runId, attemptNo])
  @@index([tenantId, status])
  @@index([tenantId, createdAt])
  @@index([runId])
}

model ManualBaseline {
  id              String   @id @default(cuid())
  tenantId        String
  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  runId           String?
  run             RunPlan? @relation(fields: [runId], references: [id], onDelete: Cascade)
  fileName        String?
  uploadedById    String
  uploadedBy      User     @relation(fields: [uploadedById], references: [id])
  createdAt       DateTime @default(now())
  totalTrucks     Int      @default(0)
  totalDistanceKm Float?
  totalTimeMin    Int?
  totalCost       Float?
  notes           String?
  assignments     ManualBaselineAssignment[]
  @@index([tenantId, createdAt])
  @@index([tenantId, runId])
}

model ManualBaselineAssignment {
  id              String   @id @default(cuid())
  baselineId      String
  baseline        ManualBaseline @relation(fields: [baselineId], references: [id], onDelete: Cascade)
  orderId         String?
  order           Order?   @relation(fields: [orderId], references: [id], onDelete: SetNull)
  truckCode       String
  sequence        Int?
  customerCode    String
  branchKey       String   @default("__MAIN__")
  cases           Int      @default(0)
  estimatedDistanceKm Float?
  estimatedTimeMin    Int?
  @@index([baselineId, truckCode])
}

model UnservedOrder {
  id            String   @id @default(cuid())
  scenarioId    String
  scenario      ScenarioResult @relation(fields: [scenarioId], references: [id], onDelete: Cascade)
  orderId       String
  order         Order    @relation(fields: [orderId], references: [id], onDelete: Cascade)
  reasonCode    UnservedReasonCode
  reasonMessage String?
  createdAt     DateTime @default(now())
  @@index([scenarioId])
  @@index([orderId])
}

model AuditLog {
  id         String   @id @default(cuid())
  tenantId   String
  tenant     Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  userId     String?
  user       User?    @relation(fields: [userId], references: [id])
  action     String   // CREATE | UPDATE | DELETE | OVERRIDE | DISPATCH | LOGIN | OPTIMIZE_STARTED | OPTIMIZE_SUCCEEDED | OPTIMIZE_FAILED | SCENARIO_CHOSEN | BASELINE_UPLOADED | ROUTE_MANUALLY_CHANGED
  entity     String   // Customer | Truck | RunPlan | RouteAssignment | ...
  entityId   String?
  beforeJson Json?
  afterJson  Json?
  ip         String?
  createdAt  DateTime @default(now())
  @@index([tenantId, createdAt])
  @@index([tenantId, entity, entityId])
}
```

### Required audit actions
In addition to standard CRUD audit logs, the following route-optimization events are mandatory:

| Action | When it is written |
|---|---|
| `OPTIMIZE_STARTED` | A `RunJob` is created and the parent `RunPlan` moves to `OPTIMIZING`. |
| `OPTIMIZE_SUCCEEDED` | Solver results are persisted, scenarios are created, and the parent `RunPlan` moves to `READY`. |
| `OPTIMIZE_FAILED` | Solver call fails, timeout/stuck janitor fails the job, or scenario persistence fails. Parent `RunPlan` moves to `FAILED`. |
| `SCENARIO_CHOSEN` | User selects a scenario and `RouteAssignment` rows are populated/replaced. |
| `BASELINE_UPLOADED` | Manual baseline file is uploaded or manually entered for a run. |
| `ROUTE_MANUALLY_CHANGED` | User moves, locks, unassigns, or resequences any stop. |

All audit entries for optimization must include the `runId`; job-specific entries must also include `runJobId`, `attemptNo`, and relevant before/after JSON where practical.

---

## 6. Excel/CSV upload contract

### Customer bulk import (master data)
Required columns (case-insensitive header match): `code, name, branch_code, region_code, address, lat, lng, priority, avg_service_time_min, payment_type`

- `payment_type` accepted values: `cash`, `credit`, `prepaid`
- `priority` 1–5
- `lat/lng` optional — if missing, customer is flagged with `geocodeConfidence: MISSING` and editable on map
- Rows with duplicate `code+branch_code` within file → reject the file with row numbers
- Blank or null `branch_code` must be normalized to `branchKey = "__MAIN__"` before validation and persistence. Never rely on nullable `branchCode` for uniqueness.
- Rows referencing unknown `region_code` → reject with line number

### Daily order upload
Required columns: `customer_code, branch_code, delivery_date, product_code, cases, priority?, notes?, payment_collection_amount?`

Validation rules (all must pass before user can click "Optimize"):
0. Every upload creates an `UploadBatch` record before validation. Validation results, warnings, source filename, user, and row counts are stored on the batch. Orders are only inserted after confirmation.
1. Every `customer_code+branch_code` must exist in tenant Customer table. Blank or null branch codes must resolve to `branchKey = "__MAIN__"`.
2. Every customer must have `lat` and `lng` set, or be marked for manual geocode on the map view.
3. Every `product_code` must exist.
4. `cases` must be positive integer.
5. `delivery_date` must be ≥ today and within next 14 days.
6. No duplicate `(customer_code, branch_code, product_code)` within file → merge by sum and warn.

Validation report screen lists every error with row number, downloadable as CSV. Upload is rejected if any error exists. Warnings (duplicates merged, missing coords) require user confirmation. The final confirmed upload must preserve the source `UploadBatch` link on every created order so the user can trace, audit, or bulk-delete a batch safely.

### Manual baseline upload for savings proof
To prove improvement against current operations, v1 supports an optional manual baseline upload for each run.

Required columns: `truck_code, customer_code, branch_code, sequence?, cases?`

Optional columns: `manual_distance_km, manual_time_min, manual_cost, notes`

Rules:
- Blank or null `branch_code` must normalize to `branchKey = "__MAIN__"`.
- Baseline customer/order rows are matched to the same run date and depot where possible.
- The system compares optimized scenarios against manual baseline on trucks used, estimated distance, estimated time, utilization, cost, unserved orders, and improvement percentage.
- If manual distance is not available, the system estimates baseline distance using the same v1 distance provider and clearly labels it as estimated.
- Baseline upload is optional, but NMWC validation should use it whenever a manual plan exists.

### Export formats
- **Excel route sheet** per truck: header (truck code, driver, date, depot, totals), table (sequence, customer code, customer name, address, cases, weight, planned arrival, signature line, notes), footer (totals).
- **PDF route sheet** per truck: same content as Excel but A4 print-formatted.
- **Master Excel** for a run: one sheet per truck + a summary sheet + an unserved-orders sheet.

---

## 7. Python solver service (OR-Tools)

### Service contract
- Deployed as a separate Railway service. Internal URL pattern: `http://routeiq-solver.railway.internal:8000` (Railway private networking).
- Authenticated via shared-secret header `X-Solver-Token` (env var, rotated periodically).
- Stateless — every request contains full input.
- Solver endpoint itself returns synchronously, but the web app must treat optimization as a `RunJob` with status polling. Do not rely on the browser keeping one request open.
- Target ≤30s for 500 stops, ≤90s for 2000 stops on default Railway plan.

### RunJob execution pattern (mandatory)

The `/api/runs/{id}/optimize` endpoint **must not block** on the solver call. Required pattern:

1. Validate run is in `DRAFT` or `FAILED` state, user has PLANNER+ role, orders exist for date+depot, and there is no active `RunJob` for the same run with `status` in (`QUEUED`, `RUNNING`).
2. Calculate `attemptNo = max(existing RunJob.attemptNo for runId) + 1`.
3. Build the solver payload before calling the solver and store it in `RunJob.requestJson`.
4. In a single DB transaction: create `RunJob` row with `status=QUEUED`, `attemptNo`, and `requestJson`; set `RunPlan.status=OPTIMIZING`; set `RunPlan.currentJobId = RunJob.id`; write `AuditLog.action = OPTIMIZE_STARTED`.
5. Schedule the solver call as a non-blocking task using a tracked promise pattern keyed by `runId` to prevent duplicate in-process execution:
   ```ts
   // lib/jobs/optimize-job.ts
   const inflight = new Map<string, Promise<void>>();

   export function scheduleOptimize(runId: string, runJobId: string) {
     if (inflight.has(runId)) return;
     const p = runOptimizeJob(runId, runJobId)
       .catch(err => failJob(runId, runJobId, err))
       .finally(() => inflight.delete(runId));
     inflight.set(runId, p);
   }
   ```
6. Return `{ runJobId, attemptNo, status: 'QUEUED' }` immediately (HTTP 202).
7. The background task marks job `RUNNING`, calls solver, persists `responseJson`, creates scenarios, marks job `SUCCEEDED`, sets `RunPlan.status=READY`, and writes `OPTIMIZE_SUCCEEDED`.
8. If the job fails at any point, mark job `FAILED`, save `errorJson`, set `RunPlan.status=FAILED`, and write `OPTIMIZE_FAILED`. The UI shows a retry action that creates a new `RunJob` attempt for the same run.
9. UI polls `/api/runs/{id}/status` every 1.5s while the current job status is `QUEUED` or `RUNNING`. Refreshing the page must resume polling against `RunPlan.currentJobId`.

**Orphan janitor.** A scheduled task (Next.js cron route hit by Railway cron every 60s, or in-process `setInterval`) marks any `RunJob` in `RUNNING` state older than 5 minutes as `FAILED` with `errorJson.reason = "STUCK"`, sets the parent `RunPlan.status=FAILED`, and writes `OPTIMIZE_FAILED`. This prevents jobs orphaned by container restarts from blocking the UI forever.

**Hard rule:** the web Node process is the only place that calls the solver in v1. v1 deployment MUST run exactly one `routeiq-web` Railway replica/instance because the in-memory `inflight` map is not safe under horizontal scaling. If Railway introduces process-level concurrency or more than one web instance, this pattern needs Redis-backed locking/BullMQ before scaling — flagged for v2.

### POST `/optimize`

**Request body:**
```json
{
  "run_id": "string",
  "tenant_id": "string",
  "depot": { "id": "string", "lat": 23.5859, "lng": 58.4059 },
  "trucks": [
    {
      "id": "T01",
      "capacity_cases": 200,
      "capacity_weight_kg": 3000,
      "fixed_cost_per_day": 25,
      "cost_per_km": 0.18
    }
  ],
  "stops": [
    {
      "order_id": "O123",
      "customer_id": "C45",
      "lat": 23.61,
      "lng": 58.55,
      "demand_cases": 30,
      "demand_weight_kg": 450,
      "service_time_min": 12,
      "priority": 2
    }
  ],
  "config": {
    "avg_speed_kmh": 40,
    "distance_provider": "HAVERSINE",
    "distance_multiplier": 1.30,
    "driver_shift_max_min": 540,
    "return_to_depot": true,
    "solver_time_limit_sec": 30,
    "scenarios_requested": ["MIN_TRUCKS", "MIN_DISTANCE", "BALANCED"]
  }
}
```

**Response body:**
```json
{
  "run_id": "string",
  "scenarios": [
    {
      "name": "BALANCED",
      "trucks_used": 7,
      "total_distance_km": 412.5,
      "total_time_min": 2310,
      "total_cost": 88.7,
      "avg_utilization_pct": 78.2,
      "distance_provider": "HAVERSINE",
      "distance_is_estimated": true,
      "unserved_orders": [
        {
          "order_id": "O999",
          "reason_code": "MISSING_COORDINATES",
          "reason_message": "Customer has no latitude/longitude"
        }
      ],
      "routes": [
        {
          "truck_id": "T01",
          "stops": [
            {
              "sequence": 1,
              "order_id": "O123",
              "customer_id": "C45",
              "planned_arrival_min": 22,
              "planned_distance_from_prev_km": 14.5,
              "planned_load_cases": 30
            }
          ],
          "total_distance_km": 62.3,
          "total_time_min": 305,
          "load_cases": 178,
          "utilization_pct": 89
        }
      ]
    }
  ],
  "warnings": ["Customer C99 outside expected range, included anyway"]
}
```

### Solver design (apps/solver/solver.py)

- Distance matrix: Haversine in v1, wrapped behind a `DistanceProvider` interface so Mapbox Matrix can drop in for v2.
- When `distanceProvider = HAVERSINE`, every UI/export/API result, dashboard KPI, report label, table header, and PDF/Excel export must say **Estimated km** instead of plain **Km**. Apply `TenantConfig.distanceMultiplier` to reduce straight-line underestimation risk. Default multiplier is 1.30 and can be adjusted by tenant/region after comparing with actual routes.
- Time matrix: `adjusted_distance_km / avg_speed_kmh * 60` + service time at each stop.
- Model: `pywrapcp.RoutingModel` with capacity dimension (cases) and time dimension (driver shift).
- First solution: `PATH_CHEAPEST_ARC`.
- Metaheuristic: `GUIDED_LOCAL_SEARCH` with `solver_time_limit_sec` cutoff.

**Scenario variants** — same data, different objectives:
- `MIN_TRUCKS`: heavy fixed-cost-per-vehicle penalty, low per-km weight. Disable trucks beyond minimum required.
- `MIN_DISTANCE`: zero fixed-cost penalty, only per-km in objective. May use more trucks.
- `BALANCED`: weighted sum from `TenantConfig.weightObjective*`. Default recommended.

**`MAX_UTILIZATION` mode** (selected at the run level via `RunPlan.optimizationMode`) does NOT produce a separate fourth solver scenario. Instead, when this mode is selected, the `BALANCED` scenario's objective is re-weighted to maximize per-truck case fill, by increasing `weightObjectiveUtilization` and decreasing the trucks-used weight. The three returned scenarios remain `MIN_TRUCKS`, `MIN_DISTANCE`, `BALANCED` — but the `BALANCED` card will be visibly biased toward fuller trucks.

**Solver time limit auto-scaling.** The base time limit from `TenantConfig.solverTimeLimitSeconds` (default 30) is auto-scaled by the solver service based on stop count:
```python
effective_time_limit = min(max(base_limit, int(stops * 0.05)), 120)
```
So 100 stops → 30s, 600 stops → 30s, 1000 stops → 50s, 2400 stops → 120s (hard cap). Tenants can raise `solverTimeLimitSeconds` if they want a higher floor; the 120s cap is hard to protect Railway resource limits.

**Heterogeneous fleet**: pass `vehicle_capacities` array with per-truck capacity. OR-Tools handles natively.

**Unserved orders**: enable disjunctions per stop. The drop penalty must be inverted with respect to priority because priority 1 is the highest (most important to serve):
```python
# priority: 1 (highest) ... 5 (lowest)
drop_penalty = 1_000_000 * (6 - priority)
# priority 1 -> 5,000,000 (very expensive to drop)
# priority 3 -> 3,000,000
# priority 5 -> 1,000,000 (cheapest to drop)
routing.AddDisjunction([manager.NodeToIndex(node)], drop_penalty)
```
This guarantees the solver drops low-priority stops first when capacity or shift constraints are infeasible. Every unserved order must return a structured reason code, not only an ID:
- `MISSING_COORDINATES`
- `EXCEEDS_TRUCK_CAPACITY`
- `NO_AVAILABLE_TRUCK`
- `SHIFT_TIME_LIMIT`
- `INVALID_CUSTOMER`
- `SOLVER_DROPPED_LOW_PRIORITY`
- `INFEASIBLE_ROUTE`
- `UNKNOWN`

**Output**: return all requested scenarios, do not pick "best" — that's a user decision.

### File: apps/solver/main.py (skeleton)
```python
from fastapi import FastAPI, HTTPException, Header
from .models import OptimizeRequest, OptimizeResponse
from .solver import optimize
import os

app = FastAPI()
SOLVER_TOKEN = os.environ["SOLVER_TOKEN"]

@app.post("/optimize", response_model=OptimizeResponse)
def optimize_endpoint(req: OptimizeRequest, x_solver_token: str = Header(...)):
    if x_solver_token != SOLVER_TOKEN:
        raise HTTPException(401)
    return optimize(req)

@app.get("/health")
def health(): return {"ok": True}
```

---

## 8. UI pages and routes

All under `/t/{slug}` unless noted.

| Route | Purpose | Key actions |
|---|---|---|
| `/login` (root) | Login | sign in |
| `/signup` (root) | Tenant signup | create tenant + admin |
| `/admin` (root, super-admin) | Platform admin | list/suspend tenants |
| `/t/{slug}/onboard` | First-time setup wizard | add depot, truck, customers |
| `/t/{slug}` | Dashboard | KPIs, recent runs, quick actions |
| `/t/{slug}/depots` | Depot CRUD | add/edit/delete |
| `/t/{slug}/trucks` | Truck CRUD | add/edit, set capacity & costs |
| `/t/{slug}/drivers` | Driver CRUD | add/edit |
| `/t/{slug}/regions` | Region CRUD | add/edit, assign default depot |
| `/t/{slug}/customers` | Customer list + CSV import | bulk import, edit, fix geocode |
| `/t/{slug}/customers/{id}` | Customer detail | edit, view orders, fix lat/lng on map |
| `/t/{slug}/products` | Product CRUD | add/edit |
| `/t/{slug}/upload` | Daily order upload | upload file, see validation report |
| `/t/{slug}/runs` | List of runs | filter by date, depot, status |
| `/t/{slug}/runs/new` | Create new run | pick depot, date, optimization mode, click optimize |
| `/t/{slug}/runs/{id}` | Run detail | tabs: Scenarios / Routes / Map / Export |
| `/t/{slug}/runs/{id}/scenarios` | Compare scenarios | side-by-side cards, pick winner, compare with manual baseline |
| `/t/{slug}/runs/{id}/baseline` | Manual baseline | upload current manual truck/customer allocation, compare savings |
| `/t/{slug}/runs/{id}/map` | Map view | colored routes, context-menu manual adjust |
| `/t/{slug}/runs/{id}/dispatch` | Finalize and export | lock run, generate Excel/PDF |
| `/t/{slug}/settings` | Tenant config | units, currency, speed, shift, objective weights |
| `/t/{slug}/audit` | Audit log | filter, search |
| `/t/{slug}/users` | User management (admin only) | invite, set role, deactivate |

---

## 9. API endpoints (Next.js route handlers)

All endpoints under `/api/...`. Tenant context resolved from session, not URL. All return `{ data, error? }` shape.

### Auth
- `POST /api/auth/signup` — body: `{ companyName, slug, country, currency, primaryUnit, email, password, name }`
- `POST /api/auth/login` (handled by NextAuth)
- `POST /api/auth/forgot` — body: `{ email }`
- `POST /api/auth/reset` — body: `{ token, newPassword }`

### Master data (each entity follows same pattern)
- `GET /api/depots` — list
- `POST /api/depots` — create
- `GET /api/depots/{id}` — detail
- `PATCH /api/depots/{id}` — update
- `DELETE /api/depots/{id}` — soft delete (set active=false)

Same for `trucks`, `drivers`, `regions`, `customers`, `products`.

### Bulk
- `POST /api/customers/import` — multipart file upload, returns `{ inserted, updated, errors[] }`
- `POST /api/products/import` — same shape

### Orders
- `POST /api/orders/upload` — multipart file upload, returns `{ batchId, validation: { errors[], warnings[] } }`
- `POST /api/orders/{batchId}/confirm` — accepts warnings and inserts into DB
- `GET /api/orders?date=YYYY-MM-DD&depotId=...` — list

### Runs
- `POST /api/runs` — body: `{ depotId, runDate, optimizationMode }` — creates DRAFT
- `POST /api/runs/{id}/optimize` — creates a `RunJob`, sets run status to `OPTIMIZING`, calls solver safely, updates job progress/status, and stores scenarios
- `GET /api/runs/{id}/status` — polling endpoint for the current `RunJob` status, attempt number, progress, message, and errors, resolved via `RunPlan.currentJobId`
- `POST /api/runs/{id}/baseline` — upload or manually enter baseline truck/customer allocation for comparison
- `GET /api/runs/{id}/baseline` — retrieve baseline comparison data
- `GET /api/runs/{id}` — detail with scenarios
- `POST /api/runs/{id}/choose-scenario` — body: `{ scenarioId }` — populates RouteAssignment
- `PATCH /api/runs/{id}/routes/{assignmentId}` — manual move/lock
- `POST /api/runs/{id}/dispatch` — finalize, lock, status → DISPATCHED
- `GET /api/runs/{id}/export/excel` — returns xlsx
- `GET /api/runs/{id}/export/pdf` — returns pdf

### Dashboard
- `GET /api/dashboard/kpis?from=...&to=...` — aggregated metrics

### Settings
- `GET /api/tenant/config`
- `PATCH /api/tenant/config`

### Audit
- `GET /api/audit?entity=...&from=...&to=...`

### Health
- `GET /api/health` — returns `{ ok: true, db: 'up' | 'down', solver: 'up' | 'down' }`. Used by Railway healthchecks and uptime monitoring. Must not require auth.

---

## 10. UI/UX standards

### Design system
- shadcn/ui base components. Customize only the theme tokens, not the components.
- Tailwind config: neutral palette, single accent color (default `blue-600`, tenant-customizable via CSS var).
- Spacing: 4/8/12/16/24/32 px scale only.
- Typography: Inter font, sizes `text-sm` for tables, `text-base` for body, `text-lg`/`text-xl` for page titles, `text-2xl` only for dashboard hero metrics.
- Border radius: `rounded-md` (6px) for inputs/buttons, `rounded-lg` (8px) for cards.
- Shadows: subtle. `shadow-sm` for cards, no `shadow-2xl` anywhere.

### Density
This is a daily operational tool. Prioritize information density over whitespace.
- Tables use `text-sm`, compact row padding.
- Forms group fields in 2-column grids on desktop where reasonable.
- Inline editing wherever possible (don't make planners click into modals to edit a row).

### Interaction principles
- Every destructive action: confirmation dialog with the entity name typed out, not just "OK/Cancel".
- Every long action (optimization, file upload): progress indicator + cancel button.
- Every list page: search (top-right), filters (top-left), bulk-select with batch actions, pagination (50/page default).
- Empty states: short message + primary CTA. Never a blank screen.
- Toasts for transient feedback (success/error). Sonner library, top-right.

### RTL readiness
- All layouts must use logical properties (`ms-/me-` instead of `ml-/mr-` in Tailwind via `dir`).
- Test in Chrome dev tools with `dir="rtl"` set on `<html>` even though copy is English-only in v1.

### Accessibility
- Color contrast WCAG AA minimum.
- Every interactive element keyboard-reachable.
- Form errors announced via `aria-live`.
- Labels associated with inputs (no placeholder-only labels).

---

## 11. Map view specifics

- Mapbox GL JS, custom style URL configurable per tenant (default to `mapbox://styles/mapbox/light-v11`).
- **Mapbox free tier**: 50,000 map loads/month. For NMWC at ~3 planners × 30 days × ~20 map loads/day = ~1,800 loads/month — well within free tier. Track usage on the platform dashboard; alert at 80% of monthly limit.
- Depot: large pin in tenant accent color, labeled.
- Stops: numbered circles, color = truck assignment. Hover shows tooltip with customer name, cases, planned arrival.
- Routes: polylines connecting stops in sequence, same color as stops, weight 3px.
- Unassigned customers: gray X markers.
- Controls:
  - Truck filter (show/hide each truck)
  - Toggle: show stop numbers / show customer names
  - Reset zoom to depot bounds
  - "Compare manual vs optimized" toggle (Phase 5+)
- **Manual adjustment** (context-menu only — drag-and-drop is unreliable on Mapbox with hundreds of stops and is not supported in v1):
  - Click a stop → context menu opens.
  - Options: "Move to truck X" (submenu lists trucks with available capacity highlighted), "Lock to current truck", "Unassign".
  - When moving a stop to another truck, the user must choose one of three insertion modes: **insert after selected stop**, **insert at end**, or **auto-position by nearest-neighbor**.
  - After every move, unassign, or insertion, the API must resequence all stops in the affected truck(s) transactionally from `1..N` to avoid violating `@@unique([runId, truckId, sequenceInTruck])`.
  - All changes go through `PATCH /api/runs/{id}/routes/{assignmentId}` which validates capacity and shift constraints before persisting. On constraint violation: show inline warning, do not save.
  - Every persisted manual change writes `AuditLog.action = ROUTE_MANUALLY_CHANGED` with before/after route snapshots for affected trucks.
  - After any change: routes re-render. The "Re-optimize" button (top-right) can re-run the solver with locked stops respected.

---

## 12. Phase-by-phase build instructions

> **Rule:** Each phase ends with a deployable, working app on Railway. The user confirms by visiting the URL and trying the listed acceptance scenarios. Only then does Claude Code start the next phase. Each phase corresponds to a Git branch `phase-N-<name>` and a tagged release.

---

### PHASE 0 — Skeleton (Week 1)

**Goal:** A blank multi-tenant app deployed and working.

**Deliverables:**
1. Turborepo monorepo with `apps/web` (Next.js) and `apps/solver` (FastAPI, just `/health` endpoint).
2. Postgres on Railway, Prisma schema migrated with all tables from section 5. **PostGIS extension enabled via init SQL** (`CREATE EXTENSION IF NOT EXISTS postgis;` in a migration step before the schema runs — not needed yet in v1 code but reserves the extension for v2 spatial queries).
3. NextAuth credentials provider, signup + login + logout flows with the password-reset policy from section 4.
4. Tenant signup creates `Tenant`, `User`, `TenantConfig` rows transactionally.
5. Path-based tenant routing middleware. `/t/{slug}` requires session and matching tenant. Tenant ownership re-validated server-side on every request — never trusted from URL alone.
6. Empty pages with nav skeleton: dashboard, depots, trucks, drivers, customers, regions, products, upload, runs, settings, audit, users.
7. Sidebar nav + top bar with tenant name and user menu.
8. Audit log writes on signup and login.
9. **shadcn/ui set up correctly**: shadcn is NOT a single npm package — components are added individually via `npx shadcn-ui@latest add button card table dialog form input select` etc. Phase 0 should add the components used in the nav skeleton (button, dropdown-menu, avatar, sheet, separator). Phase 1+ adds more as needed.
10. `GET /api/health` returns `{ ok: true, db: 'up' | 'down', solver: 'up' | 'down' }` (no auth).
11. Deployed to Railway, both services running, custom domain hooked up.
12. `.env.example` documented. README with local dev instructions.

**Acceptance scenarios:**
- I can sign up at `/signup`, create tenant "NMWC" with slug `nmwc`, log in, land on `/t/nmwc`.
- I can navigate the sidebar and see empty placeholder pages.
- `GET /api/health` returns 200 and confirms DB + solver reachable.
- Solver `/health` returns 200 from a Next.js API route that proxies it.
- A second tenant signup with different slug works independently and cannot see the first tenant's data (verify in DB, AND via attempted cross-tenant URL access — should 404, not 403, to avoid leaking tenant existence).

---

### PHASE 1 — Master data (Week 2)

**Goal:** All master data entities are CRUD-able with bulk import where it matters.

**Deliverables:**
1. Depot CRUD page + form (with map picker for lat/lng using Mapbox).
2. Truck CRUD page + form (capacity in primary unit, costs, depot assignment).
3. Driver CRUD page + form.
4. Region CRUD page + form (with optional default depot).
5. Customer list with search, filter by region, edit-in-place for priority and active flag.
6. Customer detail page with map pin and editable lat/lng.
7. Customer CSV import endpoint and UI (drag-drop, preview, validation, commit).
8. Product CRUD page.
9. Onboarding wizard at `/t/{slug}/onboard` that walks through: add 1 depot → add 1 truck → upload customer CSV (or skip).
10. Tenant settings page wired to `TenantConfig`.
11. Seed script (`pnpm db:seed:nmwc`) that loads realistic NMWC sample data: 1 Muscat depot, 8 trucks of mixed capacity, 5 regions, 150 customers with real-ish Oman coordinates, 20 products.

**Acceptance scenarios:**
- I can complete onboarding for NMWC in under 5 minutes given a CSV.
- I can edit a customer's lat/lng by dragging a pin on the map.
- I can import 150 customers from CSV with one row deliberately malformed; the bad row is rejected with a line number and the rest commit.
- I can switch primary unit from Cases to Cartons in settings and the labels across the app reflect it.

---

### PHASE 2 — Order upload + validation (Week 3)

**Goal:** Upload orders, see clean validation, and store them ready for optimization.

**Deliverables:**
1. `/upload` page: drag-drop, parse Excel and CSV, preview first 20 rows.
2. Server-side validation per rules in section 6.
3. Validation report screen: errors block, warnings dismissible, with all results stored on `UploadBatch.validationJson`.
4. Order persistence: on confirm, write `Order` + `OrderLine` rows linked to `UploadBatch`, compute totals (cases, weight, volume, service time) from products.
5. Order list page filterable by date and region; bulk delete a batch (with confirm).
6. Sample order file generator for testing (a button on the upload page in dev mode that produces a valid 150-row file matching the seeded NMWC customers).

**Acceptance scenarios:**
- I upload a 500-row Excel with 3 deliberate errors; I see them listed with row numbers and cannot proceed.
- I fix the file and re-upload; orders persist and appear in the list.
- Order totals (cases, weight) match what I expect from product master.

---

### PHASE 3 — Optimization engine (Week 4)

**Goal:** Click "Optimize" and get three valid scenarios through a polling-safe job flow in under 30 seconds for a normal NMWC day.

**Deliverables:**
1. `apps/solver` fully built per section 7.
2. Dockerfile, deployed to Railway as second service, shared secret env var.
3. `/runs/new` page: select depot, date (defaults to tomorrow), optimization mode, see order count, click Optimize.
4. Optimize button calls `/api/runs/{id}/optimize` which creates a `RunJob`, then orchestrates: pull orders for date+depot, pull trucks for depot, pull customers (with coords), build solver payload, call solver, store scenarios, and update job status. **Solver call is non-blocking per section 7's RunJob execution pattern — endpoint returns HTTP 202 immediately.**
5. Loading state with progress from polling endpoint `/api/runs/{id}/status`; the UI must not depend on one fragile long-running browser request. Poll every 1.5s.
6. **RunJob failure UI**: if `RunJob.status = FAILED`, the parent `RunPlan.status` must also be `FAILED`. The run detail page shows a red banner with `errorJson.message`, a "Retry Optimization" button that creates a new `RunJob` attempt for the same run, and a downloadable JSON of `RunJob.requestJson` plus `RunJob.responseJson` if available for support investigation.
7. **Orphan janitor**: scheduled task (cron route hit every 60s) marks any `RunJob` stuck in `RUNNING` >5 minutes as `FAILED` with `errorJson.reason = "STUCK"`.
8. Run detail page `/runs/{id}` with three tabs: Scenarios, Routes (table), Map (Phase 4).
9. Scenarios tab: three cards side by side (Min Trucks / Min Distance / Balanced), each showing trucks used, estimated distance, time, cost, utilization, unserved count with reason breakdown, and baseline comparison when available. "Pick this scenario" button.
10. On scenario pick: populate `RouteAssignment` rows, mark `RunPlan.chosenScenarioId`.
11. Routes tab: table grouped by truck, showing sequence, customer, cases, planned arrival, estimated distance from previous stop, and distance-provider label.
12. Manual baseline upload for the same run date/depot, with optimized-vs-manual comparison on trucks, distance, time, utilization, and cost.

**Acceptance scenarios:**
- Given 150 orders and 8 trucks, optimization completes in under 15 seconds.
- All three scenarios are returned and visibly different (different truck counts or distances).
- Picking a scenario shows expected route tables.
- An order with no lat/lng correctly appears in the "Unserved" list of every scenario with reason code `MISSING_COORDINATES`.
- Scenario cards clearly label Haversine-based kilometers as estimated when Mapbox Matrix is not enabled.
- A manual baseline file can be uploaded and the system shows optimized-vs-manual savings.
- **Priority drop test**: with capacity intentionally tight, the solver drops priority-5 orders before priority-1 orders. Verified by injecting one priority-1 and one priority-5 order with identical demand into an over-capacity dataset.
- **Failure path test**: kill the solver mid-run; within 5 minutes the `RunJob` transitions to `FAILED`, the parent `RunPlan.status` becomes `FAILED`, reason `STUCK` is stored, and the UI shows the retry banner.
- **Retry test**: clicking retry creates a new `RunJob` with `attemptNo + 1` for the same run and does not overwrite the failed job's `requestJson` or `errorJson`.
- **Polling test**: refreshing the run detail page mid-optimization does not break the flow — the polling resumes against `RunPlan.currentJobId`.

---

### PHASE 4 — Map, exports, manual adjust (Week 5)

**Goal:** Planners can see routes visually, tweak them, and export sheets for the warehouse.

**Deliverables:**
1. Map tab per section 11.
2. Manual adjustment via context menu (move stops between trucks with capacity check, lock stops, unassign, choose insertion mode, and resequence affected trucks transactionally — no drag-and-drop).
3. Re-optimize button after manual changes: lock manually-assigned stops, re-run solver for the rest.
4. Excel export per truck (single-truck button) and master Excel (all trucks button).
5. PDF route sheets (per truck and combined).
5a. Master export includes baseline comparison summary when a manual baseline exists.
6. Dispatch button on `/runs/{id}/dispatch`: confirmation dialog, status → DISPATCHED, audit log entry, exports become "final" version.

**Acceptance scenarios:**
- I move a stop from Truck 3 to Truck 5 in the UI, choose an insertion mode, and the affected trucks are resequenced from `1..N`; if Truck 5 capacity would be exceeded, I get a warning and can't save.
- I export an Excel with 8 sheets (one per truck) + 1 summary + 1 unserved.
- PDF prints cleanly on A4.
- After dispatch, I cannot edit assignments without explicit "unlock" action that audits.

---

### PHASE 5 — Dashboard + polish (Week 6)

**Goal:** GM-ready demo. NMWC can use it in production.

**Deliverables:**
1. Dashboard with KPI cards (today vs yesterday, week-over-week): trucks used, **Estimated km** when Haversine is active, total cost, avg utilization, cost per case, orders served, and late deliveries only as a v2 placeholder because v1 does not enforce time windows.
2. Recent runs widget (last 7 days).
3. Trend chart: trucks used per day over last 30 days.
4. Audit log page with filters.
5. User management page (invite, set role, deactivate).
6. Full empty-states pass on every page.
7. Error boundaries and 404/500 pages.
8. Loading skeletons everywhere data fetches.
9. Production telemetry: Sentry wired up.
10. Documentation: end-user README at `/help` route, admin runbook in repo `/docs/admin.md`.

**Acceptance scenarios:**
- Run the full happy path end-to-end without referring to docs: signup → onboard → upload customers → upload orders → optimize → pick scenario → adjust → export → dispatch.
- Time the entire daily run from order upload to dispatch — target ≤ 5 minutes for 150 orders.
- Demo-quality screenshots possible from every page.

---

## 13. Testing requirements

### Unit tests
- All solver logic (apps/solver/tests/): capacity math, time math, distance math (Haversine + multiplier), scenario differentiation, **priority-inverted drop penalty math** (priority 1 must produce a higher disjunction penalty than priority 5), solver time auto-scaling formula.
- All validators (Zod schemas) in apps/web.
- `tenantDb()` wrapper: **automated test** (not just a lint rule) — a Vitest suite that calls every Prisma model's findMany/findUnique/create through both `tenantDb(tenantA)` and `tenantDb(tenantB)`, asserting strict isolation. Seed two tenants with overlapping ID-like data and confirm zero leakage in both directions.

### Integration tests (Vitest + Supertest pattern against a real Postgres container)
- Auth flows: signup, login, logout, password reset (token expiry, single-use, rate limit).
- Customer CSV import: valid file, malformed file, duplicate handling, `branchKey` normalization for blank/null branches.
- Order upload: same patterns + `UploadBatch` linkage + bulk-delete-by-batch.
- Run creation, RunJob polling, and optimize: end-to-end including a deliberately failing solver call → `RunJob.status=FAILED`, `RunPlan.status=FAILED`, retry creates `attemptNo + 1`, and `requestJson`/`responseJson` are stored correctly.
- Orphan janitor: insert a `RunJob` with `startedAt` 6 minutes ago and `status=RUNNING`, run the janitor, assert `RunJob.status=FAILED`, parent `RunPlan.status=FAILED`, and reason `STUCK`.
- Manual baseline: upload, compare against optimized scenario, verify savings math.

### Cross-tenant isolation test matrix (mandatory)
For every API endpoint that returns or mutates tenant-scoped data, write a test that:
1. Logs in as Tenant A user.
2. Attempts the operation against a resource ID belonging to Tenant B.
3. Asserts HTTP 404 (NOT 403 — 403 leaks the existence of the resource).
4. Asserts no row in Tenant B was modified.

Endpoints to cover: all `/api/depots`, `/api/trucks`, `/api/drivers`, `/api/regions`, `/api/customers`, `/api/products`, `/api/orders`, `/api/runs/*`, `/api/audit`, `/api/tenant/config`. This test matrix is enforced in CI.

### E2E tests (Playwright)
- Full happy path scenario per Phase 5.
- Tenant isolation: log in as Tenant A, attempt to fetch Tenant B's data via direct URL → 404.
- Failure path: trigger a solver failure, observe FAILED banner, click Retry, observe new RunJob created.

### Test data fixtures
Create in `apps/web/tests/fixtures/`:
- `nmwc-small.csv` — 20 orders
- `nmwc-normal.csv` — 150 orders (matches seeded customers)
- `nmwc-stress.csv` — 2000 orders
- `nmwc-bad.csv` — deliberately broken (missing columns, unknown codes, negative quantities)
- `nmwc-priority-mix.csv` — orders with explicit priorities 1-5, capacity intentionally tight, to validate priority-respecting drops
- `nmwc-blank-branch.csv` — customers with blank branch codes, to validate `branchKey` normalization
- `nmwc-manual-baseline.csv` — sample manual baseline upload for comparison tests

### CI
GitHub Actions: on every PR, run lint + typecheck + unit + integration + cross-tenant matrix. E2E nightly. PR cannot merge if any test fails or if a new endpoint is added without a corresponding cross-tenant isolation test.

---

## 14. Deployment

### Railway services
1. `routeiq-web` — Next.js app
2. `routeiq-solver` — Python FastAPI
3. `routeiq-db` — Postgres

### v1 replica rule
`routeiq-web` MUST run with exactly **one** Railway replica/instance in v1. Horizontal scaling is forbidden until Redis/BullMQ locking replaces the in-memory `inflight` job guard. `routeiq-solver` may be tuned separately, but the web app remains the single scheduler/orchestrator for solver calls in v1.

### PostGIS setup on Railway
Railway's default Postgres template does NOT include PostGIS. Enable it via a first migration:
```sql
-- prisma/migrations/00000000000000_init_postgis/migration.sql
CREATE EXTENSION IF NOT EXISTS postgis;
```
This runs before Prisma's schema migrations. The extension is reserved for v2 spatial queries (region polygons, road-distance providers). v1 schema uses simple Float lat/lng and does not depend on PostGIS at query time, but the extension must be present so v2 migrations can use `geography` columns without a separate operational step.

### Environment variables
**Web:**
```
DATABASE_URL=
NEXTAUTH_SECRET=
NEXTAUTH_URL=
SOLVER_URL=http://routeiq-solver.railway.internal:8000
SOLVER_TOKEN=
MAPBOX_TOKEN=
RESEND_API_KEY=
SUPER_ADMIN_EMAILS=abdulrahman@...
SENTRY_DSN=
```

Note: Railway internal networking uses the `*.railway.internal` private DNS. Services in the same project resolve each other without going through the public internet. The solver should bind to `0.0.0.0:8000` to be reachable on that network.

**Solver:**
```
SOLVER_TOKEN=
PORT=8000
```

### Environments
- **Production** (`routeiq-prod` project on Railway): tenant `nmwc` and any paying tenants.
- **Staging** (`routeiq-staging` project): mirror of production schema, used for testing PRs before merge. Auto-deploys from `main` branch after CI passes. Required before Phase 3 ships.

### Migrations
- Run on deploy via Railway build command: `pnpm db:migrate:deploy`.
- Never edit historical migrations. Add new ones only.
- Migrations must be backward-compatible during the deploy window (zero-downtime pattern: expand → migrate code → contract over two deploys for any destructive change).

### Backups
- Railway nightly Postgres backups (built-in). Verify retention is at least 7 days.
- Once NMWC is live: add a daily `pg_dump` to an S3-compatible bucket (Cloudflare R2 cheapest) via a Railway cron service. 30-day retention. Test restore quarterly.

### Secrets rotation
- `SOLVER_TOKEN`: rotate every 90 days. Procedure: set new value, deploy solver, deploy web, retire old value. Document in `/docs/runbooks/rotate-solver-token.md`.
- `NEXTAUTH_SECRET`: do NOT rotate without rotating all active sessions (logs everyone out).

---

## 15. Security checklist

### Authentication & authorization
- [ ] Password hashing: bcrypt cost 12.
- [ ] Password reset tokens: 24h lifetime, single-use, 32-byte cryptographically random, SHA-256 hashed before DB storage, max 3 requests per email per hour.
- [ ] HTTPS only. HSTS header.
- [ ] CSRF protection on all mutating endpoints (NextAuth default).

### Tenant isolation
- [ ] `tenantDb()` wrapper required for ALL business-table queries (enforced by automated test suite in CI, not just by lint).
- [ ] Cross-tenant isolation test matrix covers every API endpoint — see section 13.
- [ ] Cross-tenant attempts return 404 (not 403) to avoid leaking resource existence.

### Input validation & abuse defense
- [ ] Zod schema validation on every API endpoint that accepts a body.
- [ ] Rate limiting (Upstash Redis in prod, in-memory in dev):
  - `/api/auth/*`: 5 requests / minute / IP
  - `/api/orders/upload`: 10 requests / hour / user (DOS defense via huge files)
  - `/api/runs/{id}/optimize`: 30 requests / hour / tenant (DOS defense via expensive solver calls)
  - All other authenticated endpoints: 300 requests / minute / user (generous default)
- [ ] File upload hardening:
  - Max 10 MB per file.
  - Content-type validation (allowlist: `text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-excel`).
  - Max 50,000 rows per file. Reject during streaming parse if exceeded, do not load the whole file into memory first.
  - SheetJS parse wrapped in try/catch with a 10-second wall-clock timeout (zip-bomb defense).
  - Filename sanitized before storing in `UploadBatch.fileName` (no path separators, max 200 chars).

### Secrets & operations
- [ ] No secrets in code. All in Railway env. `.env.example` checked in, real `.env` git-ignored.
- [ ] `SOLVER_TOKEN` rotated every 90 days per runbook.
- [ ] Sentry configured with sensitive-data scrubbing for passwords, tokens, emails (use Sentry's default scrubber + custom list).

### Audit
- [ ] Audit log all destructive actions and all dispatches.
- [ ] Audit log all optimization lifecycle and planning events: `OPTIMIZE_STARTED`, `OPTIMIZE_SUCCEEDED`, `OPTIMIZE_FAILED`, `SCENARIO_CHOSEN`, `BASELINE_UPLOADED`, `ROUTE_MANUALLY_CHANGED`.
- [ ] Audit log includes IP address from `x-forwarded-for` (Railway proxies set this).
- [ ] Dependabot / Renovate enabled — weekly PRs auto-merged for patch versions if CI passes.

---

## 16. Working agreement with Claude Code

When Claude Code reads this file and works on the build, it must follow these rules:

1. **Stay in the current phase.** Do not implement features from later phases, even if they seem easy. Defer them with a `// TODO PHASE N` comment.
2. **Ask before deviating from the spec.** If the spec says shadcn/ui, do not bring in Material UI. If the spec says Prisma, do not bring in Drizzle. If a deviation seems important, surface it to the user with a one-paragraph rationale and wait for an answer.
3. **Tenant scoping is sacred.** Every new query must go through `tenantDb(tenantId)`. Any PR that introduces an un-scoped query is invalid.
4. **Commit cadence.** One logical change per commit. Conventional commit messages. Push to the phase branch after each meaningful checkpoint.
5. **Tests required.** Phase is not "done" until acceptance scenarios pass and tests are green.
6. **Migrations are forward-only.** Never edit a committed migration file. Create a new one.
7. **No silent failures.** Every catch block logs to Sentry (or console in dev) with context.
8. **Loading and error states.** Every async UI flow has both. No raw spinners.
9. **Audit everything destructive and operationally decisive.** Every delete, override, dispatch, role change, optimization start/success/failure, scenario choice, baseline upload, and manual route change writes to `AuditLog` in the same transaction where practical.
10. **Stop at phase boundaries.** Tag a release, summarize what was built, list the acceptance checklist, wait for user sign-off.
11. **Phase-end report format.** At the end of every phase, provide: what was built, what was not built, known bugs/limitations, manual test instructions, screenshots or URLs, Git commit hash, and a clear confirmation request before moving forward.

---

## 17. Out of scope for v1 — explicitly

These are valid future features; intentionally NOT in v1:

- Driver mobile app, push notifications, proof of delivery
- Real-time GPS tracking, actual-vs-planned reconciliation
- Time windows on customers (hard or soft)
- Split deliveries
- Pickup-and-delivery
- Multi-depot in a single optimization run (v1 = one depot per run; users can run multiple times)
- Dynamic rerouting mid-day
- ERP direct integration (Oracle, SAP, RoutePro)
- AI assistant module
- Stripe billing
- Arabic translation (RTL structure ready, English copy only)
- WhatsApp/SMS notifications
- Predictive demand forecasting
- Route profitability analytics

---

## 18. v2-v4 roadmap (preview only, do not build)

**v2 (months 4-6):** Time windows. Multi-depot single run. Mapbox Matrix API for road distances. Stripe billing. Arabic UI. Light ERP CSV scheduled imports. Better cost model with fuel index.

**v3 (months 7-9):** Driver mobile app (PWA first, native later). GPS ingestion via Geotab/Samsara webhooks. Actual-vs-planned reconciliation page. Proof of delivery (photo, signature).

**v4 (months 10-12):** AI assistant for explanations and recommendations. Predictive truck-requirement forecasting. Dynamic rerouting. Real ERP integrations (Oracle Logistics first).

---

## 19. Final notes for Claude Code

You are the build engineer. The user (Abdulrahman) is the product owner and will validate at every phase boundary. The first tenant in production is NMWC (National Mineral Water Company, Oman), with 7 depots, mixed truck fleet, and ~150 orders/day per depot.

When in doubt: prefer boring, prefer tested, prefer the spec. Ship working phases, not partial visions.

Begin by reading this entire file, then say:
> "I've read the spec. I'm ready to start Phase 0. Confirm and I'll begin."

End of specification.
