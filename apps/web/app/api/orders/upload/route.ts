import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { tenantDb } from '@/lib/tenant';
import { audit } from '@/lib/audit';
import { hasRole } from '@/lib/api';
import { parseUpload } from '@/lib/csv';
import { fileHash, validateIntake } from '@/lib/dispatch/intake-server';
import { dateOnly } from '@/lib/dispatch/time';
import { rateLimit, LIMITS } from '@/lib/rate-limit';
import { clientIp } from '@/lib/client-ip';

// 10 MB / 50k rows / content-type guard (lib/csv). Unknown customers and products are NOT
// errors here: they are listed and created on confirm, then completed by the dispatcher.

export async function POST(req: Request) {
  const session = await auth();
  // 401 only for "no session" (the dispatch screen then sends the browser to sign in again), like
  // withTenantApi; a session without a tenant (platform admin) is 403.
  if (!session?.user) return NextResponse.json({ data: null, error: 'Unauthorized' }, { status: 401 });
  if (!session.user.tenantId) return NextResponse.json({ data: null, error: 'No tenant on session' }, { status: 403 });
  if (!hasRole(session.user.role, 'PLANNER')) {
    return NextResponse.json({ data: null, error: 'Forbidden' }, { status: 403 });
  }
  const tenantId = session.user.tenantId;
  const ip = clientIp(req);
  const r = rateLimit(`orders-upload:${tenantId}:${session.user.id}`, LIMITS.ordersUpload.limit, LIMITS.ordersUpload.windowMs);
  if (!r.ok) return NextResponse.json({ data: null, error: 'Too many uploads. Try again later.' }, { status: 429 });

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ data: null, error: 'No file uploaded' }, { status: 400 });
  }
  const depotId = (form.get('depotId') as string | null) || null;
  const deliveryDate = (form.get('deliveryDate') as string | null) || null;
  if (deliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) {
    return NextResponse.json({ data: null, error: 'deliveryDate must be YYYY-MM-DD' }, { status: 400 });
  }

  let parsed;
  try {
    parsed = await parseUpload(file);
  } catch (err) {
    return NextResponse.json({ data: null, error: (err as Error).message }, { status: 400 });
  }

  let v;
  try {
    v = await validateIntake(tenantId, parsed.rows, { depotId, defaultDeliveryDate: deliveryDate });
  } catch (err) {
    return NextResponse.json({ data: null, error: (err as Error).message }, { status: 400 });
  }
  const db = tenantDb(tenantId);
  const hash = fileHash(parsed.rows);
  const sameFile = await db.uploadBatch.findFirst({ where: { fileHash: hash, status: 'CONFIRMED', depotId: v.depotId } });
  if (sameFile) {
    v.errors.unshift({ row: 1, message: `This exact file was already confirmed (batch ${sameFile.fileName}, ${sameFile.uploadedAt.toISOString()}).` });
  }
  const topDate = v.totals.deliveryDates[0] ?? deliveryDate;

  const batch = await db.uploadBatch.create({
    data: {
      tenantId,
      fileName: parsed.fileName,
      fileType: parsed.fileType,
      uploadedById: session.user.id,
      deliveryDate: topDate ? dateOnly(topDate) : null,
      status: v.errors.length > 0 ? 'PARSED' : 'VALIDATED',
      totalRows: parsed.rows.length,
      validRows: v.lines.length,
      errorRows: v.errors.length,
      warningRows: v.warnings.length + v.duplicates.length,
      validationJson: v as never,
      depotId: v.depotId,
      fileHash: hash,
      isLate: v.late.isLate,
    },
  });

  await audit({
    tenantId,
    userId: session.user.id,
    action: 'CREATE',
    entity: 'UploadBatch',
    entityId: batch.id,
    afterJson: { fileName: batch.fileName, rows: parsed.rows.length, lines: v.lines.length, errors: v.errors.length, cases: v.totals.cases, late: v.late.isLate } as never,
    ip,
  });

  return NextResponse.json({
    data: {
      batchId: batch.id,
      validation: {
        totalRows: parsed.rows.length,
        validRows: v.lines.length,
        errorRows: v.errors.length,
        warningRows: v.warnings.length + v.duplicates.length,
        errors: v.errors,
        warnings: [...v.warnings, ...v.duplicates.map((d) => `Row ${d.row}: ${d.message}`), ...parsed.warnings],
        duplicates: v.duplicates,
        totals: v.totals,
        fileCases: v.fileCases,
        issues: v.issues,
        mapping: v.mapping,
        unmappedColumns: v.unmappedColumns,
        late: v.late,
        depotCode: v.depotCode,
      },
    },
    error: null,
  });
}
