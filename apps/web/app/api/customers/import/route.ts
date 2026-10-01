import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { tenantDb } from '@/lib/tenant';
import { audit } from '@/lib/audit';
import { parseUploadIsolated, UploadParseRefused, uploadRefusedResponse } from '@/lib/upload-parse';
import { MAX_SERVICE_MIN, normalizeBranchKey } from '@/lib/schemas';
import { hasRole } from '@/lib/api';
import { rateLimit, LIMITS } from '@/lib/rate-limit';
import { customerKey, preferredCustomer } from '@/lib/dispatch/order-intake';
import { fileAgreesWithSaved, pointsElsewhereText, readImportedPair, type ImportedPair } from '@/lib/dispatch/import-location';
import { tenantServiceArea } from '@/lib/dispatch/service-area';
import { LOCATION_ADMIN_ONLY_MESSAGE, locationBlocksDelivery, savedLocationLocked } from '@/lib/dispatch/customer-attrs';
import { samePoint } from '@/lib/dispatch/location-input';
import { canManageMasterData } from '@/lib/rbac';
import { clientIp } from '@/lib/client-ip';

// Per CLAUDE.md §15: 10 MB / 50k rows / content-type guard; the file is read in the parser process
// (audit P5, lib/upload-parse).
//
// Columns: code, name and priority are required. Every other column is written only when the
// file has it AND the cell is not blank: a re-import without a column never erases what the
// dispatcher entered (service time, region, address, payment type, location). A service time
// from the file counts as confirmed for that customer (it wins over the customer-type default).
// Codes match existing customers whatever their letter case (as in the order intake).
//
// Locations (owner's rule, audit PR A5: "locations should always be correct"): each lat/lng pair is
// read like ADD LOCATION reads "lat, lng", with the company's delivery area (`readImportedPair`; an
// Excel number cell counts the decimals it shows). A pair that is not exact (fewer than 4 decimals,
// swapped, outside the area, 0,0) is never stored as a usable location, and the row is listed in
// `locationsNotSaved` with the reason in plain words. It is not an error: the rest of the row and the
// rest of the file are imported. A new customer gets no coordinates (it shows LOCATION REQUIRED). An
// existing one keeps its saved point when the file's pair points at the same place (within the
// file's own precision); when the file points elsewhere (A5 review: the customer moved, or one of
// the two is wrong) its saved point stays on the map but is marked LOW, so it is not planned until a
// dispatcher drops the pin. A kept saved point that is itself not usable (LOW, or outside the area,
// and never confirmed) is listed as not used, with its own warning (A5 second review). A location a
// dispatcher verified is never changed (F05). An exact pair that replaces a saved point that was not
// usable is recorded (CUSTOMER_LOCATION_SET, the point it replaced): a stop still planned at that
// point is then refused at LOCK, LOADING and DISPATCH until a re-plan (A5 third review). The pair and
// its row commit together, judged on the customer as it is when written (A5 fifth review). Rows that
// keep a usable saved location are counted apart: nothing to do for them (A5 fifth review).
//
// Owner decision 1 Oct 2026 (location admin-lock): an import by a dispatcher (PLANNER, SUPERVISOR)
// never changes a customer's usable saved location (`savedLocationLocked`): the file's pair, exact or
// not, is ignored for such a customer (never marked LOW either), the row says "Only an admin can
// change a saved location", and a warning counts them. It still sets the location of a new customer
// or of one without a usable location. An admin's import works as above (A5's exact-location rules).

interface ImportError {
  row: number;
  message: string;
}

/** A row whose location was not saved because it is not exact (owner's location rule). */
interface LocationNotSaved {
  row: number;
  code: string;
  branchCode: string | null;
  reason: string;
  /**
   * What the customer has: SAVED_LOCATION = it exists and keeps its saved point, which is usable
   * (confirmed, or the file points at the same place); SAVED_LOCATION_NEEDS_PIN = the file points
   * elsewhere, so its saved point (never confirmed) is marked LOW and not used until the pin is placed
   * by hand; SAVED_LOCATION_NOT_USABLE = it keeps its saved point, but that point is itself not usable
   * (LOW, or outside the delivery area, and never confirmed: `locationBlocksDelivery`), so it is not
   * used until the pin is placed by hand (A5 second review; it is not marked again); null = it has none.
   */
  kept: 'SAVED_LOCATION' | 'SAVED_LOCATION_NEEDS_PIN' | 'SAVED_LOCATION_NOT_USABLE' | null;
}

interface CustomerRow {
  row: number;
  code: string;
  name: string;
  branchCode: string | null;
  branchKey: string;
  regionCode: string | null; // null = not in the file (keep)
  address: string | null; // null = not in the file (keep)
  lat: number | null;
  lng: number | null;
  priority: number;
  avgServiceTimeMin: number | null; // null = not in the file (keep; 10 min on create, unconfirmed)
  paymentType: 'CASH' | 'CREDIT' | 'PREPAID' | null; // null = not in the file (keep; CREDIT on create)
}

const PAYMENT_TYPES = new Set(['CASH', 'CREDIT', 'PREPAID']);

function parsePayment(raw: string): 'CASH' | 'CREDIT' | 'PREPAID' | null {
  const up = raw.toUpperCase().trim();
  if (PAYMENT_TYPES.has(up)) return up as 'CASH' | 'CREDIT' | 'PREPAID';
  return null;
}

const cell = (raw: Record<string, string>, key: string) => (raw[key] ?? '').toString().trim();

export async function POST(req: Request) {
  const session = await auth();
  // 401 only for "no session" (the dispatch screen then sends the browser to sign in again), like
  // withTenantApi; a session without a tenant (platform admin) is 403.
  if (!session?.user) return NextResponse.json({ data: null, error: 'Unauthorized' }, { status: 401 });
  if (!session.user.tenantId) return NextResponse.json({ data: null, error: 'No tenant on session' }, { status: 403 });
  if (!hasRole(session.user.role, 'PLANNER')) {
    return NextResponse.json({ data: null, error: 'Forbidden' }, { status: 403 });
  }
  const ip = clientIp(req);

  const r = rateLimit(`customers-import:${session.user.tenantId}:${session.user.id}`, LIMITS.ordersUpload.limit, LIMITS.ordersUpload.windowMs);
  if (!r.ok) return NextResponse.json({ data: null, error: 'Too many uploads. Try again later.' }, { status: 429 });

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ data: null, error: 'No file uploaded' }, { status: 400 });
  }
  const dryRun = form.get('dryRun') === '1';

  let parsed;
  try {
    // lat / lng from Excel: the decimals the cell shows count (23.5850, not the number 23.585), a
    // number format adding one zero at most (23.58 shown as 23.5800 is 23.580: A5 fourth review).
    parsed = await parseUploadIsolated(file, { decimalTextColumns: ['lat', 'lng'] });
  } catch (err) {
    // Too long, too much memory, the reader stopped, or busy (503): nothing was saved.
    if (err instanceof UploadParseRefused) return uploadRefusedResponse(err);
    return NextResponse.json({ data: null, error: (err as Error).message }, { status: 400 });
  }

  const errors: ImportError[] = [];
  const warnings: string[] = [...parsed.warnings];
  const valid: CustomerRow[] = [];
  const codeSeen = new Map<string, number>();
  const notExact: { row: number; pair: ImportedPair }[] = [];

  const db = tenantDb(session.user.tenantId);
  const regions = await db.region.findMany({ select: { id: true, code: true } });
  const area = await tenantServiceArea(session.user.tenantId);
  const isAdmin = canManageMasterData(session.user.role);
  const regionByCode = new Map(regions.map((r) => [r.code.toLowerCase(), r.id]));

  parsed.rows.forEach((raw, idx) => {
    const row = idx + 2; // header + 1-based
    const code = cell(raw, 'code');
    const name = cell(raw, 'name');
    if (!code || !name) {
      errors.push({ row, message: 'Missing required column (code, name).' });
      return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(code) || code.length > 32) {
      errors.push({ row, message: `Invalid code "${code}".` });
      return;
    }

    const branchCode = cell(raw, 'branch_code') || null;
    const branchKey = normalizeBranchKey(branchCode);
    const dupKey = customerKey(code, branchKey);
    if (codeSeen.has(dupKey)) {
      errors.push({
        row,
        message: `Duplicate code+branch within file (also on row ${codeSeen.get(dupKey)}; letter case does not matter).`,
      });
      return;
    }
    codeSeen.set(dupKey, row);

    const regionCodeRaw = cell(raw, 'region_code');
    let regionCode: string | null = null;
    if (regionCodeRaw) {
      regionCode = regionCodeRaw;
      if (!regionByCode.has(regionCodeRaw.toLowerCase())) {
        errors.push({ row, message: `Unknown region_code "${regionCodeRaw}".` });
        return;
      }
    }

    const priorityNum = Number(cell(raw, 'priority'));
    if (!Number.isInteger(priorityNum) || priorityNum < 1 || priorityNum > 5) {
      errors.push({ row, message: `priority must be an integer 1-5 (got "${raw['priority'] ?? ''}").` });
      return;
    }

    const serviceRaw = cell(raw, 'avg_service_time_min');
    let serviceMin: number | null = null;
    if (serviceRaw) {
      serviceMin = Number(serviceRaw);
      if (!Number.isInteger(serviceMin) || serviceMin < 0 || serviceMin > MAX_SERVICE_MIN) {
        errors.push({ row, message: `avg_service_time_min must be a whole number 0-${MAX_SERVICE_MIN} (got "${serviceRaw}").` });
        return;
      }
    }

    const paymentRaw = cell(raw, 'payment_type');
    const payment = paymentRaw ? parsePayment(paymentRaw) : null;
    if (paymentRaw && !payment) {
      errors.push({ row, message: `payment_type must be cash | credit | prepaid (got "${paymentRaw}").` });
      return;
    }

    const latRaw = cell(raw, 'lat');
    const lngRaw = cell(raw, 'lng');
    let lat: number | null = null;
    let lng: number | null = null;
    if (latRaw || lngRaw) {
      const latN = Number(latRaw);
      const lngN = Number(lngRaw);
      if (!latRaw || !Number.isFinite(latN) || latN < -90 || latN > 90) {
        errors.push({ row, message: 'lat must be -90..90.' });
        return;
      }
      if (!lngRaw || !Number.isFinite(lngN) || lngN < -180 || lngN > 180) {
        errors.push({ row, message: 'lng must be -180..180.' });
        return;
      }
      // Read as ADD LOCATION reads "lat, lng" (the text as in the file, so its decimals count).
      const pair = readImportedPair(latRaw, lngRaw, area);
      if (pair.point) {
        lat = pair.point.lat;
        lng = pair.point.lng;
      } else {
        notExact.push({ row, pair });
      }
    } else {
      warnings.push(`Row ${row} (${code}): missing coordinates — will need map geocode.`);
    }

    valid.push({
      row,
      code,
      name,
      branchCode,
      branchKey,
      regionCode,
      address: cell(raw, 'address') || null,
      lat,
      lng,
      priority: priorityNum,
      avgServiceTimeMin: serviceMin,
      paymentType: payment,
    });
  });

  // Existing customers, matched case-insensitively (twins resolve like the order intake).
  const existingRows = await db.customer.findMany({
    select: { id: true, code: true, branchKey: true, active: true, lat: true, lng: true, locationVerified: true, geocodeConfidence: true, locationSource: true, avgServiceTimeMin: true, serviceTimeConfirmed: true },
  });
  const twins = new Map<string, typeof existingRows>();
  for (const c of existingRows) twins.set(customerKey(c.code, c.branchKey), [...(twins.get(customerKey(c.code, c.branchKey)) ?? []), c]);
  const matchOf = (v: CustomerRow) => {
    const list = twins.get(customerKey(v.code, v.branchKey));
    return list ? preferredCustomer(list) ?? null : null;
  };
  let creates = 0;
  let updates = 0;
  const confirmedServiceChanges: { code: string; branchCode: string | null; from: number; to: number }[] = [];
  const locationsNotSaved: LocationNotSaved[] = [];
  // Customers whose saved point (never confirmed) the file contradicts: marked LOW at commit, only if
  // still unverified and still at the point compared here.
  const needsPin = new Map<string, { lat: number; lng: number }>();
  // Customers that keep a saved point which is itself not usable (A5 second review): listed as such,
  // never marked again, and counted in their own warning.
  const keptNotUsable = new Set<string>();
  // Rows whose pair differs from the customer's usable saved location, in a dispatcher's import: the
  // saved location is kept (owner decision 1 Oct 2026, item 5: only an admin can change it).
  const adminOnlyRows = new Set<number>();
  const notExactByRow = new Map(notExact.map((n) => [n.row, n.pair]));
  for (const v of valid) {
    const pair = notExactByRow.get(v.row);
    if (pair === undefined) continue;
    const m = matchOf(v);
    const reason = pair.reason ?? 'Not exact.';
    if (!m || m.lat === null || m.lng === null) {
      locationsNotSaved.push({ row: v.row, code: v.code, branchCode: v.branchCode, reason, kept: null });
      continue;
    }
    const saved = { lat: m.lat, lng: m.lng };
    if (!m.locationVerified && !fileAgreesWithSaved(pair, saved) && savedLocationLocked(isAdmin, m, area)) {
      // A dispatcher's file pointing elsewhere does not touch a usable saved location (item 5).
      adminOnlyRows.add(v.row);
      locationsNotSaved.push({ row: v.row, code: v.code, branchCode: v.branchCode, reason: `${reason} ${pointsElsewhereText(pair, saved)} ${LOCATION_ADMIN_ONLY_MESSAGE}`, kept: 'SAVED_LOCATION' });
      continue;
    }
    if (m.locationVerified || fileAgreesWithSaved(pair, saved)) {
      const usable = !locationBlocksDelivery(m, area);
      if (!usable) keptNotUsable.add(m.id);
      locationsNotSaved.push({ row: v.row, code: v.code, branchCode: v.branchCode, reason, kept: usable ? 'SAVED_LOCATION' : 'SAVED_LOCATION_NOT_USABLE' });
    } else {
      needsPin.set(m.id, saved);
      locationsNotSaved.push({ row: v.row, code: v.code, branchCode: v.branchCode, reason: `${reason} ${pointsElsewhereText(pair, saved)}`, kept: 'SAVED_LOCATION_NEEDS_PIN' });
    }
  }
  // A5 fifth review: only the rows whose customer has no usable location after the import are told to
  // set it on the map; a customer that keeps a usable saved location (confirmed, or the file points at
  // the same place) is planned and sent out as before, so its rows are counted apart.
  const keptUsable = locationsNotSaved.filter((l) => l.kept === 'SAVED_LOCATION' && !adminOnlyRows.has(l.row)).length;
  const needPin = locationsNotSaved.filter((l) => l.kept !== 'SAVED_LOCATION').length;
  // Exact pairs of a dispatcher's file that would change a usable saved location: kept (item 5).
  for (const v of valid) {
    if (v.lat === null || v.lng === null) continue;
    const m = matchOf(v);
    if (m && savedLocationLocked(isAdmin, m, area) && !(m.lat !== null && m.lng !== null && samePoint({ lat: m.lat, lng: m.lng }, { lat: v.lat, lng: v.lng }))) {
      adminOnlyRows.add(v.row);
    }
  }
  if (adminOnlyRows.size) {
    warnings.push(
      `${adminOnlyRows.size} location(s) in the file differ from the customer's saved location, which ${dryRun || errors.length > 0 ? 'will be' : 'was'} kept: ${LOCATION_ADMIN_ONLY_MESSAGE} Ask your company admin to import the file, or to change each one with Set location on the customer page.`,
    );
  }
  if (needPin) {
    // A5 fourth review: the tense follows what happens (Validate only, or a file with errors, saves
    // nothing yet), like the warning below. The fix is never "format the cells to show 4 decimals":
    // a number holds no trailing zeros, and a cell of 23.58 shown as 23.5800 is not exact.
    warnings.push(
      `${needPin} location(s) in the file are not exact and ${dryRun || errors.length > 0 ? 'will not be' : 'were not'} saved. Set them on the map (ADD LOCATION on Daily dispatch, or Set location on the customer page), or fix the file: type or paste each coordinate with all the decimals it really has (at least 4); if Excel drops a trailing zero, format the lat and lng columns as Text before typing or pasting.`,
    );
  }
  if (keptUsable) {
    warnings.push(
      `${keptUsable} location(s) in the file are not exact, but each of these customers keeps the location it already has, which is used as before: nothing to do. To correct the file, type or paste each coordinate with all the decimals it really has (at least 4).`,
    );
  }
  // What happens to their orders is what the system enforces: not planned (planning leaves them
  // unserved) and not sent out (LOCK, LOADING and DISPATCH refuse their loads, plan-service
  // locationGate). A load already on the road is not called back (A5 second review).
  const untilPin = 'Their orders are not planned or sent out until then. Drop the pin on each one (ADD LOCATION on Daily dispatch, or Set location on the customer page).';
  if (needsPin.size) {
    warnings.push(`${needsPin.size} saved location(s) ${dryRun || errors.length > 0 ? 'will not be' : 'are not'} used until the pin is placed by hand: the file points somewhere else. ${untilPin}`);
  }
  if (keptNotUsable.size) {
    warnings.push(
      `${keptNotUsable.size} saved location(s) are not used until the pin is placed by hand: the saved location is not exact or is outside the delivery area, and nobody confirmed it. ${untilPin}`,
    );
  }
  for (const v of valid) {
    const m = matchOf(v);
    if (!m) {
      creates++;
      continue;
    }
    updates++;
    if (m.code !== v.code) warnings.push(`Row ${v.row}: ${v.code} updates the existing customer ${m.code} (codes are the same whatever the letter case).`);
    if (v.avgServiceTimeMin !== null && m.serviceTimeConfirmed && m.avgServiceTimeMin !== v.avgServiceTimeMin) {
      confirmedServiceChanges.push({ code: m.code, branchCode: v.branchCode, from: m.avgServiceTimeMin, to: v.avgServiceTimeMin });
    }
  }
  if (confirmedServiceChanges.length) {
    warnings.push(
      `${confirmedServiceChanges.length} confirmed service time(s) will change: ${confirmedServiceChanges
        .slice(0, 10)
        .map((c) => `${c.code}${c.branchCode ? ` / ${c.branchCode}` : ''} ${c.from} -> ${c.to} min`)
        .join(', ')}${confirmedServiceChanges.length > 10 ? ', ...' : ''}.`,
    );
  }

  if (errors.length > 0 || dryRun) {
    return NextResponse.json({
      data: {
        fileName: parsed.fileName,
        totalRows: parsed.rows.length,
        validRows: valid.length,
        errorRows: errors.length,
        warningRows: warnings.length,
        errors,
        warnings,
        dryRun,
        creates,
        updates,
        confirmedServiceChanges,
        locationsNotSaved,
      },
      error: null,
    });
  }

  // Commit. Existing locations are never wiped by a file without coordinates, and a location a
  // dispatcher confirmed on the map is never overwritten by an import - also one confirmed while
  // this import runs (audit F05): the coordinates are written by their own update whose condition
  // is "still not verified", checked by PostgreSQL on the row as it is at that moment (not on the
  // list read above), and the kept count comes from what those updates did.
  let upserted = 0;
  let keptVerified = 0;
  let markedLow = 0;
  let replacedNotUsable = 0;
  for (const v of valid) {
    const regionId = v.regionCode ? regionByCode.get(v.regionCode.toLowerCase()) ?? null : null;
    const fileHasLoc = v.lat !== null && v.lng !== null;
    const geocodeConfidence = fileHasLoc ? 'HIGH' : 'MISSING';
    const m = matchOf(v);
    if (!m) {
      await db.customer.create({
        data: {
          tenantId: session.user.tenantId,
          code: v.code,
          name: v.name,
          branchCode: v.branchCode,
          branchKey: v.branchKey,
          regionId,
          address: v.address,
          lat: v.lat,
          lng: v.lng,
          geocodeConfidence,
          locationSource: fileHasLoc ? 'IMPORT' : undefined,
          priority: v.priority,
          priorityConfirmed: true,
          // A time from the file is the customer's own; without one the default 10 min is only a
          // placeholder (the customer-type time applies until someone confirms one).
          ...(v.avgServiceTimeMin !== null ? { avgServiceTimeMin: v.avgServiceTimeMin, serviceTimeConfirmed: true } : {}),
          ...(v.paymentType ? { paymentType: v.paymentType } : {}),
        },
      });
    } else {
      await db.customer.update({
        where: { id: m.id },
        data: {
          name: v.name,
          ...(v.regionCode ? { regionId } : {}),
          ...(v.address ? { address: v.address } : {}),
          priority: v.priority,
          priorityConfirmed: true,
          ...(v.avgServiceTimeMin !== null ? { avgServiceTimeMin: v.avgServiceTimeMin, serviceTimeConfirmed: true } : {}),
          ...(v.paymentType ? { paymentType: v.paymentType } : {}),
        },
      });
      if (fileHasLoc) {
        const data = { lat: v.lat, lng: v.lng, geocodeConfidence, locationSource: 'IMPORT' as const };
        // A saved point that was not usable (an earlier file marked it LOW, or it is outside the area)
        // replaced by the file's exact pair is recorded like a pin set in ADD LOCATION, so a stop
        // still planned at the old point is refused at LOCK, LOADING and DISPATCH until a re-plan
        // gives it the new one (plan-service locationGate, A5 third review).
        const needsRow = (c: { lat: number | null; lng: number | null; locationVerified: boolean; geocodeConfidence: string | null }) =>
          c.lat !== null && c.lng !== null && locationBlocksDelivery(c, area) && !samePoint({ lat: c.lat, lng: c.lng }, { lat: v.lat!, lng: v.lng! });
        let outcome: 'KEPT_VERIFIED' | 'KEPT_LOCKED' | 'WRITTEN' | 'REPLACED' | null = null;
        if (savedLocationLocked(isAdmin, m, area)) {
          // A dispatcher's import never changes a usable saved location (item 5; counted above).
          outcome = 'KEPT_LOCKED';
        } else if (m.locationVerified) {
          // Nothing un-confirms a location, so this one stays as it is (F05: checked on the row).
          const written = await db.customer.updateMany({ where: { id: m.id, locationVerified: false }, data });
          if (written.count === 0) outcome = 'KEPT_VERIFIED';
        } else if (!needsRow(m)) {
          // Most rows, in one statement: written only while the customer is still as the import read
          // it (still not confirmed, at that point, with that confidence), so "no row needed" holds
          // for the row as it is when written (A5 fifth review; before, a point another file marked
          // LOW meanwhile was replaced with no row).
          const written = await db.customer.updateMany({
            where: { id: m.id, locationVerified: false, lat: m.lat, lng: m.lng, geocodeConfidence: m.geocodeConfidence },
            data,
          });
          if (written.count === 1) outcome = 'WRITTEN';
        }
        if (!outcome) {
          // The customer changed since the import read it, or the change needs its row: lock the
          // customer, judge it as it is, and write the pair and the row in one transaction (A5 fifth
          // review; before, the row was written after the change, so a restart or a failed insert
          // between them left the change without its row, and LOCK passed the stale stop).
          const tenantId = session.user.tenantId;
          outcome = await db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${m.id} AND "tenantId" = ${tenantId} FOR UPDATE`;
            const now = await tx.customer.findFirst({
              where: { id: m.id },
              select: { lat: true, lng: true, locationVerified: true, geocodeConfidence: true, locationSource: true },
            });
            // Item 5, on the row as it is now (locked): a usable location saved meanwhile is kept for a
            // dispatcher, nothing written.
            if (now && savedLocationLocked(isAdmin, now, area)) return 'KEPT_LOCKED' as const;
            const written = await tx.customer.updateMany({ where: { id: m.id, locationVerified: false }, data });
            if (written.count === 0 || !now) return 'KEPT_VERIFIED' as const;
            if (!needsRow(now)) return 'WRITTEN' as const;
            await audit(
              {
                tenantId,
                userId: session.user.id,
                action: 'CUSTOMER_LOCATION_SET',
                entity: 'Customer',
                entityId: m.id,
                beforeJson: { lat: now.lat, lng: now.lng, source: now.locationSource, verified: now.locationVerified, confidence: now.geocodeConfidence } as never,
                afterJson: { lat: v.lat, lng: v.lng, source: 'IMPORT', confidence: geocodeConfidence, check: 'IMPORT', fileName: parsed.fileName } as never,
                ip,
              },
              tx as unknown as Prisma.TransactionClient,
            );
            return 'REPLACED' as const;
          });
        }
        if (outcome === 'KEPT_VERIFIED') keptVerified++;
        else if (outcome === 'REPLACED') replacedNotUsable++;
      } else {
        // The file points elsewhere: the saved point is not used until a dispatcher drops the pin
        // (LOW blocks planning). Never a verified one, nor one changed since it was compared (F05).
        const saved = needsPin.get(m.id);
        if (saved) {
          const marked = await db.customer.updateMany({
            where: { id: m.id, locationVerified: false, lat: saved.lat, lng: saved.lng },
            data: { geocodeConfidence: 'LOW' },
          });
          markedLow += marked.count;
        }
      }
    }
    upserted++;
  }

  await audit({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    action: 'CREATE',
    entity: 'Customer',
    entityId: null,
    afterJson: {
      bulkImport: {
        fileName: parsed.fileName, upserted, creates, updates, confirmedServiceChanges, locationsNotSaved: locationsNotSaved.length,
        savedLocationsMarkedLow: markedLow, savedLocationsNotUsable: keptNotUsable.size, savedLocationsNotUsableReplaced: replacedNotUsable,
        savedLocationsKeptAdminOnly: adminOnlyRows.size,
      },
    } as never,
    ip,
  });

  return NextResponse.json({
    data: {
      fileName: parsed.fileName,
      totalRows: parsed.rows.length,
      validRows: valid.length,
      errorRows: 0,
      warningRows: warnings.length,
      upserted,
      creates,
      updates,
      confirmedServiceChanges,
      locationsNotSaved,
      keptVerifiedLocations: keptVerified,
      warnings: keptVerified ? [...warnings, `${keptVerified} customer location(s) confirmed by a dispatcher were kept (file coordinates ignored).`] : warnings,
    },
    error: null,
  });
}
