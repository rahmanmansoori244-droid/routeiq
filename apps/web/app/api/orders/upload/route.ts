import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { tenantDb } from '@/lib/tenant';
import { audit } from '@/lib/audit';
import { hasRole } from '@/lib/api';
import { parseUpload } from '@/lib/csv';
import { validateOrderRows } from '@/lib/order-validate';
import { rateLimit, LIMITS } from '@/lib/rate-limit';

// Per CLAUDE.md §15: 10 MB / 50k rows / content-type guard. 10/hr/user rate limit.

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || !session.user.tenantId) {
    return NextResponse.json({ data: null, error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasRole(session.user.role, 'PLANNER')) {
    return NextResponse.json({ data: null, error: 'Forbidden' }, { status: 403 });
  }
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  const r = rateLimit(
    `orders-upload:${session.user.tenantId}:${session.user.id}`,
    LIMITS.ordersUpload.limit,
    LIMITS.ordersUpload.windowMs,
  );
  if (!r.ok) return NextResponse.json({ data: null, error: 'Too many uploads. Try again later.' }, { status: 429 });

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ data: null, error: 'No file uploaded' }, { status: 400 });
  }

  let parsed;
  try {
    parsed = await parseUpload(file);
  } catch (err) {
    return NextResponse.json({ data: null, error: (err as Error).message }, { status: 400 });
  }

  const db = tenantDb(session.user.tenantId);
  const result = await validateOrderRows(parsed.rows, db);

  // Pull a representative deliveryDate (most common) for the batch row.
  const dateCounts = new Map<string, number>();
  for (const v of result.validated) dateCounts.set(v.deliveryDate, (dateCounts.get(v.deliveryDate) ?? 0) + 1);
  let topDate: string | null = null;
  let topCount = 0;
  for (const [d, c] of dateCounts) {
    if (c > topCount) {
      topDate = d;
      topCount = c;
    }
  }

  const batch = await db.uploadBatch.create({
    data: {
      tenantId: session.user.tenantId,
      fileName: parsed.fileName,
      fileType: parsed.fileType,
      uploadedById: session.user.id,
      deliveryDate: topDate ? new Date(topDate) : null,
      status: result.errorRows > 0 ? 'PARSED' : 'VALIDATED',
      totalRows: result.totalRows,
      validRows: result.validRows,
      errorRows: result.errorRows,
      warningRows: result.warningRows,
      validationJson: {
        errors: result.errors,
        warnings: result.warnings,
        validated: result.validated,
      } as never,
    },
  });

  await audit({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    action: 'CREATE',
    entity: 'UploadBatch',
    entityId: batch.id,
    afterJson: {
      fileName: batch.fileName,
      totalRows: batch.totalRows,
      validRows: batch.validRows,
      errorRows: batch.errorRows,
    } as never,
    ip,
  });

  return NextResponse.json({
    data: {
      batchId: batch.id,
      validation: {
        totalRows: result.totalRows,
        validRows: result.validRows,
        errorRows: result.errorRows,
        warningRows: result.warningRows,
        errors: result.errors,
        warnings: result.warnings,
      },
    },
    error: null,
  });
}
