import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { tenantDb } from '@/lib/tenant';
import { audit } from '@/lib/audit';
import { parseUploadIsolated, UploadParseRefused, uploadRefusedResponse } from '@/lib/upload-parse';
import { MAX_SERVICE_MIN, normalizeBranchKey } from '@/lib/schemas';
import { hasRole } from '@/lib/api';
import { rateLimit, LIMITS } from '@/lib/rate-limit';
import { preferredCustomer } from '@/lib/dispatch/order-intake';
import { customerKey } from '@/lib/customer-code';
import { fileAgreesWithSaved, pointsElsewhereText, readImportedPair, type ImportedPair } from '@/lib/dispatch/import-location';
import { tenantServiceArea } from '@/lib/dispatch/service-area';
import { LOCATION_ADMIN_ONLY_MESSAGE, locationBlocksDelivery, savedLocationLocked } from '@/lib/dispatch/customer-attrs';
import { samePoint } from '@/lib/dispatch/location-input';
import { canManageMasterData } from '@/lib/rbac';
import { clientIp } from '@/lib/client-ip';
import { HOURS_COLUMNS, importedPriority, readImportedHours, rowVersion, yesNo, type PriorityConfirm } from '@/lib/dispatch/data-collection';

const HOUR_FIELDS = ['hardWindowStartMin', 'hardWindowEndMin', 'prefWindowStartMin', 'prefWindowEndMin'] as const;

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
//
// Owner decision 1 Oct 2026 (item 6, daily customer master): the downloaded master (and the data-to-
// collect list) is read back by this import. Its receiving-hours columns (hard_from, hard_to,
// preferred_from, preferred_to, open_all_day, hours_confirmed: lib/dispatch/data-collection
// readImportedHours) set the customer's own hours, confirmed by the importer unless hours_confirmed
// says no; with a priority_confirmed column an unchanged priority that is not confirmed stays as it is
// (importedPriority; without the column every priority is confirmed, as before). A row that changes nothing
// writes nothing (so the master imported back as downloaded changes nothing, and "Changed since"
// lists only real changes; a saved point that is confirmed or exact is the same point whatever its
// source); each customer it changes gets its own audit row with what it was and became: UPDATE for
// its fields (and a point marked LOW), CUSTOMER_LOCATION_SET for each location it writes, CREATE for
// each customer it creates. Rows without lat / lng whose customer has no usable location are counted
// in one warning.
//
// Data collection review: a downloaded row carries the customer's version (hidden row_version,
// lib/dispatch/data-collection rowVersion); a row whose customer was changed in RouteIQ after the
// download is not imported at all (an old file would undo the change, and confirm old hours under the
// importer's name), and the rows it would have changed are listed (`staleRows`). A code outside the
// import's own format is accepted when it matches an existing customer (an order file creates any
// non-blank code); a new customer still needs a plain code. A pair that differs from a pin confirmed
// on the map is counted apart in a dispatcher's import: no import changes such a pin, an admin's neither.

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
  /** priority_confirmed (importedPriority): ABSENT = the file has no such column (confirmed, as before). */
  priorityConfirm: PriorityConfirm;
  /** The receiving-hours cells (HOURS_COLUMNS) the file has, for readImportedHours. */
  hoursCells: Partial<Record<(typeof HOURS_COLUMNS)[number], string>>;
  /** The customer as the downloaded file showed it (row_version, rowVersion); null = a file without it. */
  rowVersion: string | null;
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

  // Existing customers, matched case-insensitively (twins resolve like the order intake).
  const existingRows = await db.customer.findMany({
    select: {
      id: true, code: true, branchKey: true, active: true, lat: true, lng: true, locationVerified: true, geocodeConfidence: true, locationSource: true, avgServiceTimeMin: true, serviceTimeConfirmed: true,
      // What a row would change (item 6: a row that changes nothing writes nothing, so a master imported back changes nothing).
      name: true, regionId: true, address: true, priority: true, priorityConfirmed: true, paymentType: true,
      hardWindowStartMin: true, hardWindowEndMin: true, prefWindowStartMin: true, prefWindowEndMin: true, windowConfirmedAt: true,
    },
  });
  const twins = new Map<string, typeof existingRows>();
  for (const c of existingRows) twins.set(customerKey(c.code, c.branchKey), [...(twins.get(customerKey(c.code, c.branchKey)) ?? []), c]);
  const matchOf = (v: { code: string; branchKey: string }) => {
    const list = twins.get(customerKey(v.code, v.branchKey));
    return list ? preferredCustomer(list) ?? null : null;
  };
  // Rows of a file downloaded before their customer was changed in RouteIQ (row_version): not imported.
  const staleRows: { row: number; code: string; branchCode: string | null; changes: boolean }[] = [];

  parsed.rows.forEach((raw, idx) => {
    const row = idx + 2; // header + 1-based
    const code = cell(raw, 'code');
    const name = cell(raw, 'name');
    if (!code || !name) {
      errors.push({ row, message: 'Missing required column (code, name).' });
      return;
    }
    const branchCode = cell(raw, 'branch_code') || null;
    const branchKey = normalizeBranchKey(branchCode);
    // A code an order file created (any non-blank text, e.g. "AB 12") is matched like the order intake
    // matches it; the strict format applies only to a customer the import would create (data
    // collection review: such a customer on the data-to-collect list refused the whole file).
    if ((!/^[A-Za-z0-9._-]+$/.test(code) || code.length > 32) && !matchOf({ code, branchKey })) {
      errors.push({ row, message: `Invalid code "${code}".` });
      return;
    }
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
    // Item 6 (customer master read back): priority_confirmed and the receiving-hours columns.
    const priorityFlag = yesNo(cell(raw, 'priority_confirmed'));
    if (priorityFlag === undefined) {
      errors.push({ row, message: `priority_confirmed must be yes or no (got "${cell(raw, 'priority_confirmed')}").` });
      return;
    }
    const priorityConfirm: PriorityConfirm = !('priority_confirmed' in raw) ? 'ABSENT' : priorityFlag === null ? 'BLANK' : priorityFlag ? 'YES' : 'NO';
    const hoursCells = Object.fromEntries(HOURS_COLUMNS.filter((k) => k in raw).map((k) => [k, cell(raw, k)]));
    const hoursCheck = readImportedHours(hoursCells, null);
    if (!hoursCheck.ok) {
      errors.push({ row, message: hoursCheck.error });
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
    }
    // No lat / lng: the customer keeps what it has. Those left without a usable location are counted
    // in one warning below (not one line per row: a master of thousands leaves many blank).

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
      priorityConfirm,
      hoursCells,
      rowVersion: cell(raw, 'row_version') || null,
    });
  });

  // Data collection review: a row of a downloaded file (the master, the data-to-collect list) whose
  // customer was changed in RouteIQ after the download (its hidden row_version is not the customer's
  // now) is not imported at all: compared with the customer as it is now, every value someone changed
  // since would count as a change by the file - an old file undid later edits and confirmed hours
  // nobody checked under the importer's name. Rows that would change something are listed.
  const notExactRows = new Set(notExact.map((n) => n.row));
  const changesSomething = (v: CustomerRow, m: NonNullable<ReturnType<typeof matchOf>>): boolean => {
    if (v.name !== m.name || (v.address && v.address !== m.address) || (v.paymentType && v.paymentType !== m.paymentType)) return true;
    if (v.regionCode && (regionByCode.get(v.regionCode.toLowerCase()) ?? null) !== m.regionId) return true;
    const p = importedPriority(v.priority, v.priorityConfirm, m);
    if (p.priority !== null || p.confirm) return true;
    if (v.avgServiceTimeMin !== null && (v.avgServiceTimeMin !== m.avgServiceTimeMin || !m.serviceTimeConfirmed)) return true;
    const h = readImportedHours(v.hoursCells, m);
    if (h.ok && h.change && (h.change.confirm !== 'KEEP' || HOUR_FIELDS.some((k) => h.change!.hours[k] !== m[k]))) return true;
    if (notExactRows.has(v.row)) return true;
    if (v.lat === null || v.lng === null) return false;
    const same = m.lat !== null && m.lng !== null && samePoint({ lat: m.lat, lng: m.lng }, { lat: v.lat, lng: v.lng });
    return !(same && (m.locationVerified || m.geocodeConfidence === 'HIGH'));
  };
  const fresh = valid.filter((v) => {
    const m = v.rowVersion ? matchOf(v) : null;
    if (!m || rowVersion(m) === v.rowVersion) return true;
    staleRows.push({ row: v.row, code: v.code, branchCode: v.branchCode, changes: changesSomething(v, m) });
    return false;
  });
  valid.splice(0, valid.length, ...fresh);
  const staleListed = staleRows.filter((s) => s.changes).map(({ row, code, branchCode }) => ({ row, code, branchCode }));
  if (staleListed.length) {
    const codes = staleListed.slice(0, 10).map((s) => `${s.code}${s.branchCode ? ` / ${s.branchCode}` : ''}`).join(', ');
    const later = dryRun || errors.length > 0;
    warnings.push(
      `${staleListed.length} row(s) ${later ? 'will not be' : 'were not'} imported: the customer was changed in RouteIQ after this file was downloaded (${codes}${staleListed.length > 10 ? ', ...' : ''}). Nothing in those rows ${later ? 'will be' : 'was'} saved. Download a new file and enter those changes again.`,
    );
  }

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
  // Rows without lat / lng whose customer has no usable location (new, none saved, or a saved one that
  // cannot be used): one plain count. A customer that keeps a usable saved location needs nothing.
  const noLocation = valid.filter((v) => {
    if (v.lat !== null || notExactByRow.has(v.row)) return false;
    const m = matchOf(v);
    return !m || m.lat === null || m.lng === null || locationBlocksDelivery(m, area);
  }).length;
  if (noLocation) {
    warnings.push(
      `${noLocation} customer(s) in the file have no usable location and no lat / lng in the file. Their orders are not planned or sent out until the pin is dropped (ADD LOCATION on Daily dispatch, or Set location on the customer page).`,
    );
  }
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
  // Exact pairs of a dispatcher's file that would change a usable saved location: kept (item 5). A pin
  // confirmed on the map is counted apart: no import changes it, an admin's neither (owner decision),
  // so "ask your company admin to import the file" would not help for it (data collection review).
  const adminOnlyVerifiedRows = new Set<number>();
  for (const v of valid) {
    if (v.lat === null || v.lng === null) continue;
    const m = matchOf(v);
    if (m && savedLocationLocked(isAdmin, m, area) && !(m.lat !== null && m.lng !== null && samePoint({ lat: m.lat, lng: m.lng }, { lat: v.lat, lng: v.lng }))) {
      if (m.locationVerified) adminOnlyVerifiedRows.add(v.row);
      else adminOnlyRows.add(v.row);
    }
  }
  const kept = dryRun || errors.length > 0 ? 'will be' : 'was';
  if (adminOnlyRows.size) {
    warnings.push(
      `${adminOnlyRows.size} location(s) in the file differ from the customer's saved location, which ${kept} kept: ${LOCATION_ADMIN_ONLY_MESSAGE} Ask your company admin to import the file, or to change each one with Set location on the customer page.`,
    );
  }
  if (adminOnlyVerifiedRows.size) {
    warnings.push(
      `${adminOnlyVerifiedRows.size} location(s) in the file differ from a location confirmed on the map, which ${kept} kept: no import changes a location confirmed on the map (an admin's neither). If one is wrong, ask your company admin to change it with Set location on the customer page.`,
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
        staleRows: staleListed,
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
  let unchanged = 0;
  let hoursChanged = 0;
  let keptVerified = 0;
  let markedLow = 0;
  let replacedNotUsable = 0;
  const importedAt = new Date();
  const importTenantId = session.user.tenantId;
  for (const v of valid) {
    const regionId = v.regionCode ? regionByCode.get(v.regionCode.toLowerCase()) ?? null : null;
    const fileHasLoc = v.lat !== null && v.lng !== null;
    const geocodeConfidence = fileHasLoc ? 'HIGH' : 'MISSING';
    const m = matchOf(v);
    // Receiving hours (owner decisions 1 Oct 2026, items 2 and 6): hours entered here are confirmed by
    // the importer unless hours_confirmed says no; nothing un-confirms hours that did not change.
    const hours = readImportedHours(v.hoursCells, m);
    const hoursData: Record<string, unknown> = {};
    if (hours.ok && hours.change) {
      for (const k of HOUR_FIELDS) if (!m || hours.change.hours[k] !== m[k]) hoursData[k] = hours.change.hours[k];
      if (hours.change.confirm === 'SET') Object.assign(hoursData, { windowConfirmedAt: importedAt, windowConfirmedById: session.user.id });
      else if (hours.change.confirm === 'CLEAR' && m?.windowConfirmedAt) Object.assign(hoursData, { windowConfirmedAt: null, windowConfirmedById: null });
    }
    if (Object.keys(hoursData).length) hoursChanged++;
    if (!m) {
      const created = await db.customer.create({
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
          priorityConfirmed: importedPriority(v.priority, v.priorityConfirm, null).confirm,
          // A time from the file is the customer's own; without one the default 10 min is only a
          // placeholder (the customer-type time applies until someone confirms one).
          ...(v.avgServiceTimeMin !== null ? { avgServiceTimeMin: v.avgServiceTimeMin, serviceTimeConfirmed: true } : {}),
          ...(v.paymentType ? { paymentType: v.paymentType } : {}),
          ...hoursData,
        },
      });
      // Its own row, so "Changed since" in the customer master says who created it and from which file.
      const { windowConfirmedById: _by, ...hoursShown } = hoursData;
      await audit({
        tenantId: session.user.tenantId,
        userId: session.user.id,
        action: 'CREATE',
        entity: 'Customer',
        entityId: created.id,
        afterJson: {
          code: v.code, branchCode: v.branchCode, name: v.name, regionId, lat: v.lat, lng: v.lng, priority: v.priority, ...hoursShown, source: 'IMPORT', fileName: parsed.fileName,
        } as never,
        ip,
      });
    } else {
      // Only what the row changes is written (item 6): a customer master imported back as it was
      // downloaded changes nothing, so "Changed since" lists only real changes. Each customer changed
      // gets its own audit row (what it was, what the file made it).
      const data: Record<string, unknown> = { ...hoursData };
      if (v.name !== m.name) data.name = v.name;
      if (v.regionCode && regionId !== m.regionId) data.regionId = regionId;
      if (v.address && v.address !== m.address) data.address = v.address;
      // An unchanged priority the master shows as not confirmed stays as it is (a default stays a default).
      const p = importedPriority(v.priority, v.priorityConfirm, m);
      if (p.priority !== null) data.priority = p.priority;
      if (p.confirm) data.priorityConfirmed = true;
      if (v.avgServiceTimeMin !== null && (v.avgServiceTimeMin !== m.avgServiceTimeMin || !m.serviceTimeConfirmed)) {
        Object.assign(data, { avgServiceTimeMin: v.avgServiceTimeMin, serviceTimeConfirmed: true });
      }
      if (v.paymentType && v.paymentType !== m.paymentType) data.paymentType = v.paymentType;
      let wrote = false;
      if (Object.keys(data).length) {
        wrote = true;
        await db.customer.update({ where: { id: m.id }, data });
        const { windowConfirmedById: _by, ...shown } = data;
        await audit({
          tenantId: session.user.tenantId,
          userId: session.user.id,
          action: 'UPDATE',
          entity: 'Customer',
          entityId: m.id,
          beforeJson: Object.fromEntries(Object.keys(shown).map((k) => [k, (m as Record<string, unknown>)[k] ?? null])) as never,
          afterJson: { ...shown, source: 'IMPORT', fileName: parsed.fileName } as never,
          ip,
        });
      }
      const samePlace = fileHasLoc && m.lat !== null && m.lng !== null && samePoint({ lat: m.lat, lng: m.lng }, { lat: v.lat!, lng: v.lng! });
      if (samePlace && (m.locationVerified || m.geocodeConfidence === 'HIGH')) {
        // The file's point is the saved one, already confirmed or exact (from a file, a pin, or a
        // customer created with coordinates): nothing to write, its source stays (item 6, a customer
        // master imported back).
      } else if (fileHasLoc) {
        const data = { lat: v.lat, lng: v.lng, geocodeConfidence, locationSource: 'IMPORT' as const };
        // Each location the import writes has its own row (who, from what, to what), so "Changed since"
        // in the customer master can say it; one that replaced a point that was not usable is also what
        // plan-service locationGate reads.
        const locationRow = (before: { lat: number | null; lng: number | null; locationSource: string | null; locationVerified: boolean; geocodeConfidence: string | null }) => ({
          tenantId: importTenantId,
          userId: session.user.id,
          action: 'CUSTOMER_LOCATION_SET' as const,
          entity: 'Customer' as const,
          entityId: m.id,
          beforeJson: { lat: before.lat, lng: before.lng, source: before.locationSource, verified: before.locationVerified, confidence: before.geocodeConfidence } as never,
          afterJson: { lat: v.lat, lng: v.lng, source: 'IMPORT', confidence: geocodeConfidence, check: 'IMPORT', fileName: parsed.fileName } as never,
          ip,
        });
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
          if (written.count === 1) {
            outcome = 'WRITTEN';
            await audit(locationRow(m));
          }
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
            await audit(locationRow(now), tx as unknown as Prisma.TransactionClient);
            return needsRow(now) ? ('REPLACED' as const) : ('WRITTEN' as const);
          });
        }
        if (outcome === 'KEPT_VERIFIED') keptVerified++;
        else if (outcome === 'REPLACED') replacedNotUsable++;
        if (outcome === 'WRITTEN' || outcome === 'REPLACED') wrote = true;
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
          if (marked.count) {
            wrote = true;
            await audit({
              tenantId: session.user.tenantId,
              userId: session.user.id,
              action: 'UPDATE',
              entity: 'Customer',
              entityId: m.id,
              beforeJson: { geocodeConfidence: m.geocodeConfidence } as never,
              afterJson: { geocodeConfidence: 'LOW', source: 'IMPORT', fileName: parsed.fileName } as never,
              ip,
            });
          }
        }
      }
      if (!wrote) unchanged++;
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
        savedLocationsKeptAdminOnly: adminOnlyRows.size, savedLocationsKeptConfirmedOnMap: adminOnlyVerifiedRows.size, unchanged, receivingHoursChanged: hoursChanged,
        staleRowsSkipped: staleRows.length,
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
      unchanged,
      receivingHoursChanged: hoursChanged,
      confirmedServiceChanges,
      locationsNotSaved,
      staleRows: staleListed,
      keptVerifiedLocations: keptVerified,
      warnings: keptVerified ? [...warnings, `${keptVerified} customer location(s) confirmed by a dispatcher were kept (file coordinates ignored).`] : warnings,
    },
    error: null,
  });
}
