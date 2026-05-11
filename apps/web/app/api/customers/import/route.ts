import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { tenantDb } from '@/lib/tenant';
import { audit } from '@/lib/audit';
import { parseUpload } from '@/lib/csv';
import { normalizeBranchKey } from '@/lib/schemas';
import { hasRole } from '@/lib/api';
import { rateLimit, LIMITS } from '@/lib/rate-limit';

// Per CLAUDE.md §15: 10 MB / 50k rows / content-type guard.

interface ImportError {
  row: number;
  message: string;
}

interface CustomerRow {
  code: string;
  name: string;
  branchCode: string | null;
  branchKey: string;
  regionCode: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  priority: number;
  avgServiceTimeMin: number;
  paymentType: 'CASH' | 'CREDIT' | 'PREPAID';
}

const PAYMENT_TYPES = new Set(['CASH', 'CREDIT', 'PREPAID']);

function parsePayment(raw: string): 'CASH' | 'CREDIT' | 'PREPAID' | null {
  const up = raw.toUpperCase().trim();
  if (PAYMENT_TYPES.has(up)) return up as 'CASH' | 'CREDIT' | 'PREPAID';
  return null;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || !session.user.tenantId) {
    return NextResponse.json({ data: null, error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasRole(session.user.role, 'PLANNER')) {
    return NextResponse.json({ data: null, error: 'Forbidden' }, { status: 403 });
  }
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

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
    const code = raw['code'];
    const name = raw['name'];
    if (!code || !name) {
      errors.push({ row, message: 'Missing required column (code, name).' });
      return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(code) || code.length > 32) {
      errors.push({ row, message: `Invalid code "${code}".` });
      return;
    }

    const branchCode = raw['branch_code'] ? raw['branch_code'] : null;
    const branchKey = normalizeBranchKey(branchCode);
    const dupKey = `${code}::${branchKey}`;
    if (codeSeen.has(dupKey)) {
      errors.push({
        row,
        message: `Duplicate code+branch within file (also on row ${codeSeen.get(dupKey)}).`,
      });
      return;
    }
    codeSeen.set(dupKey, row);

    const regionCodeRaw = raw['region_code'] || '';
    let regionCode: string | null = null;
    if (regionCodeRaw) {
      regionCode = regionCodeRaw;
      if (!regionByCode.has(regionCodeRaw.toLowerCase())) {
        errors.push({ row, message: `Unknown region_code "${regionCodeRaw}".` });
        return;
      }
    }

    const priorityNum = Number(raw['priority']);
    if (!Number.isInteger(priorityNum) || priorityNum < 1 || priorityNum > 5) {
      errors.push({ row, message: `priority must be an integer 1-5 (got "${raw['priority']}").` });
      return;
    }

    const serviceMin = Number(raw['avg_service_time_min'] || 10);
    if (!Number.isFinite(serviceMin) || serviceMin < 0 || serviceMin > 600) {
      errors.push({ row, message: 'avg_service_time_min must be 0-600.' });
      return;
    }

    const payment = parsePayment(raw['payment_type'] || 'CREDIT');
    if (!payment) {
      errors.push({ row, message: `payment_type must be cash | credit | prepaid (got "${raw['payment_type']}").` });
      return;
    }

    const latRaw = raw['lat'];
    const lngRaw = raw['lng'];
    let lat: number | null = null;
    let lng: number | null = null;
    if (latRaw || lngRaw) {
      const latN = Number(latRaw);
      const lngN = Number(lngRaw);
      if (!Number.isFinite(latN) || latN < -90 || latN > 90) {
        errors.push({ row, message: 'lat must be -90..90.' });
        return;
      }
      if (!Number.isFinite(lngN) || lngN < -180 || lngN > 180) {
        errors.push({ row, message: 'lng must be -180..180.' });
        return;
      }
      lat = latN;
      lng = lngN;
    } else {
      warnings.push(`Row ${row} (${code}): missing coordinates — will need map geocode.`);
    }

    valid.push({
      code,
      name,
      branchCode,
      branchKey,
      regionCode,
      address: raw['address'] || null,
      lat,
      lng,
      priority: priorityNum,
      avgServiceTimeMin: serviceMin,
      paymentType: payment,
    });
  });

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
      },
      error: null,
    });
  }

  // Commit
  let upserted = 0;
  for (const v of valid) {
    const regionId = v.regionCode ? regionByCode.get(v.regionCode.toLowerCase()) ?? null : null;
    const geocodeConfidence = v.lat !== null && v.lng !== null ? 'HIGH' : 'MISSING';
    await db.customer.upsert({
      where: {
        tenantId_code_branchKey: {
          tenantId: session.user.tenantId,
          code: v.code,
          branchKey: v.branchKey,
        },
      },
      create: {
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
        priority: v.priority,
        avgServiceTimeMin: v.avgServiceTimeMin,
        paymentType: v.paymentType,
      },
      update: {
        name: v.name,
        regionId,
        address: v.address,
        lat: v.lat,
        lng: v.lng,
        geocodeConfidence,
        priority: v.priority,
        avgServiceTimeMin: v.avgServiceTimeMin,
        paymentType: v.paymentType,
      },
    });
    upserted++;
  }

  await audit({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    action: 'CREATE',
    entity: 'Customer',
    entityId: null,
    afterJson: { bulkImport: { fileName: parsed.fileName, upserted } } as never,
    ip,
  });

  // unused prisma var guard
  void prisma;
  // satisfy zod import for future schema use
  void z;

  return NextResponse.json({
    data: {
      fileName: parsed.fileName,
      totalRows: parsed.rows.length,
      validRows: valid.length,
      errorRows: 0,
      warningRows: warnings.length,
      upserted,
      warnings,
    },
    error: null,
  });
}
