import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { tenantDb } from '@/lib/tenant';
import { audit } from '@/lib/audit';
import { hasRole, fail, ok } from '@/lib/api';
import { parseUpload } from '@/lib/csv';
import { normalizeBranchKey } from '@/lib/schemas';
import { rateLimit, LIMITS } from '@/lib/rate-limit';
import { clientIp } from '@/lib/client-ip';

interface Params { params: { id: string } }

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user) return fail('Unauthorized', 401);
  if (!session.user.tenantId) return fail('No tenant on session', 403);
  if (!hasRole(session.user.role, 'PLANNER')) return fail('Forbidden', 403);
  const ip = clientIp(req);

  const r = rateLimit(
    `baseline-upload:${session.user.tenantId}:${session.user.id}`,
    LIMITS.ordersUpload.limit,
    LIMITS.ordersUpload.windowMs,
  );
  if (!r.ok) return fail('Too many uploads. Try again later.', 429);

  const db = tenantDb(session.user.tenantId);
  const run = await db.runPlan.findUnique({ where: { id: params.id } });
  if (!run) return fail('Run not found', 404);

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return fail('No file uploaded', 400);

  let parsed;
  try {
    parsed = await parseUpload(file);
  } catch (err) {
    return fail((err as Error).message, 400);
  }

  // Group rows by truck code, validate customer codes against tenant.
  interface Row {
    truck_code: string;
    customer_code: string;
    branchKey: string;
    sequence: number | null;
    cases: number;
    distanceKm: number | null;
    timeMin: number | null;
  }

  const customers = await db.customer.findMany({ select: { id: true, code: true, branchKey: true } });
  const custByKey = new Map(customers.map((c) => [`${c.code}::${c.branchKey}`, c]));

  // Orders on this run date so we can link assignments to actual orders.
  const orders = await db.order.findMany({
    where: { deliveryDate: run.runDate },
    select: { id: true, customerId: true, totalCases: true },
  });
  const ordersByCust = new Map(orders.map((o) => [o.customerId, o]));

  const rows: Row[] = [];
  const warnings: string[] = [];
  parsed.rows.forEach((raw, idx) => {
    const fileRow = idx + 2;
    const truck_code = (raw['truck_code'] ?? '').trim();
    const customer_code = (raw['customer_code'] ?? '').trim();
    if (!truck_code || !customer_code) {
      warnings.push(`Row ${fileRow}: missing truck_code or customer_code, skipped.`);
      return;
    }
    const branchKey = normalizeBranchKey(raw['branch_code'] ?? '');
    rows.push({
      truck_code,
      customer_code,
      branchKey,
      sequence: raw['sequence'] ? Number(raw['sequence']) : null,
      cases: raw['cases'] ? Number(raw['cases']) : 0,
      distanceKm: raw['manual_distance_km'] ? Number(raw['manual_distance_km']) : null,
      timeMin: raw['manual_time_min'] ? Number(raw['manual_time_min']) : null,
    });
  });

  if (rows.length === 0) return fail('No baseline rows found in the file.', 400);

  // Totals
  const trucksUsed = new Set(rows.map((r2) => r2.truck_code)).size;
  let totalDistanceKm = 0;
  let totalTimeMin = 0;
  for (const r2 of rows) {
    if (r2.distanceKm !== null && Number.isFinite(r2.distanceKm)) totalDistanceKm += r2.distanceKm;
    if (r2.timeMin !== null && Number.isFinite(r2.timeMin)) totalTimeMin += r2.timeMin;
  }

  const baseline = await db.manualBaseline.create({
    data: {
      tenantId: session.user.tenantId,
      runId: run.id,
      fileName: parsed.fileName,
      uploadedById: session.user.id,
      totalTrucks: trucksUsed,
      totalDistanceKm: totalDistanceKm || null,
      totalTimeMin: totalTimeMin || null,
      notes: warnings.length > 0 ? `Warnings: ${warnings.length}` : null,
      assignments: {
        create: rows.map((r2) => {
          const cust = custByKey.get(`${r2.customer_code}::${r2.branchKey}`);
          const order = cust ? ordersByCust.get(cust.id) : null;
          return {
            orderId: order?.id ?? null,
            truckCode: r2.truck_code,
            sequence: r2.sequence,
            customerCode: r2.customer_code,
            branchKey: r2.branchKey,
            cases: r2.cases || order?.totalCases || 0,
            estimatedDistanceKm: r2.distanceKm,
            estimatedTimeMin: r2.timeMin,
          };
        }),
      },
    },
    include: { _count: { select: { assignments: true } } },
  });

  await audit({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    action: 'BASELINE_UPLOADED',
    entity: 'ManualBaseline',
    entityId: baseline.id,
    afterJson: {
      runId: run.id,
      totalTrucks: trucksUsed,
      assignments: baseline._count.assignments,
      fileName: parsed.fileName,
    } as never,
    ip,
  });

  return NextResponse.json(
    {
      data: {
        baselineId: baseline.id,
        totalTrucks: trucksUsed,
        assignments: baseline._count.assignments,
        warnings,
      },
      error: null,
    },
    { status: 201 },
  );
}

export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user) return fail('Unauthorized', 401);
  if (!session.user.tenantId) return fail('No tenant on session', 403);
  const db = tenantDb(session.user.tenantId);

  // Cross-tenant access on the runId must 404, not return an empty list.
  const run = await db.runPlan.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!run) return fail('Run not found', 404);

  const baselines = await db.manualBaseline.findMany({
    where: { runId: params.id },
    orderBy: { createdAt: 'desc' },
    include: {
      uploadedBy: { select: { id: true, name: true, email: true } },
      _count: { select: { assignments: true } },
    },
  });
  return ok({ baselines });
}
