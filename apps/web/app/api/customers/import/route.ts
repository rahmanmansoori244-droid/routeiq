import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { tenantDb } from '@/lib/tenant';
import { audit } from '@/lib/audit';
import { parseUpload } from '@/lib/csv';
import { MAX_SERVICE_MIN, normalizeBranchKey } from '@/lib/schemas';
import { hasRole } from '@/lib/api';
import { rateLimit, LIMITS } from '@/lib/rate-limit';
import { customerKey, preferredCustomer } from '@/lib/dispatch/order-intake';
import { clientIp } from '@/lib/client-ip';

// Per CLAUDE.md §15: 10 MB / 50k rows / content-type guard.
//
// Columns: code, name and priority are required. Every other column is written only when the
// file has it AND the cell is not blank: a re-import without a column never erases what the
// dispatcher entered (service time, region, address, payment type, location). A service time
// from the file counts as confirmed for that customer (it wins over the customer-type default).
// Codes match existing customers whatever their letter case (as in the order intake).

interface ImportError {
  row: number;
  message: string;
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
    parsed = await parseUpload(file);
  } catch (err) {
    return NextResponse.json({ data: null, error: (err as Error).message }, { status: 400 });
  }

  const errors: ImportError[] = [];
  const warnings: string[] = [...parsed.warnings];
  const valid: CustomerRow[] = [];
  const codeSeen = new Map<string, number>();

  const db = tenantDb(session.user.tenantId);
  const regions = await db.region.findMany({ select: { id: true, code: true } });
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
      lat = latN;
      lng = lngN;
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
    select: { id: true, code: true, branchKey: true, active: true, lat: true, lng: true, locationVerified: true, avgServiceTimeMin: true, serviceTimeConfirmed: true },
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
      },
      error: null,
    });
  }

  // Commit. Existing locations are never wiped by a file without coordinates, and a location a
  // dispatcher confirmed on the map is never overwritten by an import.
  let upserted = 0;
  let keptVerified = 0;
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
      if (m.locationVerified && fileHasLoc) keptVerified++;
      const locUpdate = fileHasLoc && !m.locationVerified ? { lat: v.lat, lng: v.lng, geocodeConfidence, locationSource: 'IMPORT' as const } : {};
      await db.customer.update({
        where: { id: m.id },
        data: {
          name: v.name,
          ...(v.regionCode ? { regionId } : {}),
          ...(v.address ? { address: v.address } : {}),
          ...locUpdate,
          priority: v.priority,
          priorityConfirmed: true,
          ...(v.avgServiceTimeMin !== null ? { avgServiceTimeMin: v.avgServiceTimeMin, serviceTimeConfirmed: true } : {}),
          ...(v.paymentType ? { paymentType: v.paymentType } : {}),
        },
      });
    }
    upserted++;
  }

  await audit({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    action: 'CREATE',
    entity: 'Customer',
    entityId: null,
    afterJson: { bulkImport: { fileName: parsed.fileName, upserted, creates, updates, confirmedServiceChanges } } as never,
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
      keptVerifiedLocations: keptVerified,
      warnings: keptVerified ? [...warnings, `${keptVerified} customer location(s) confirmed by a dispatcher were kept (file coordinates ignored).`] : warnings,
    },
    error: null,
  });
}
