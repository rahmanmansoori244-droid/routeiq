import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { tenantDb } from '@/lib/tenant';
import { audit } from '@/lib/audit';
import { hasRole } from '@/lib/api';
import { MultipleSheetsError } from '@/lib/upload-errors';
import { parseUploadIsolated, UploadParseRefused, uploadRefusedResponse } from '@/lib/upload-parse';
import { prisma } from '@/lib/db';
import { DepotRequired, findSameConfirmedFile, INTAKE_CHECK_FAILED, legacyRowsHash, validateIntake } from '@/lib/dispatch/intake-server';
import type { CanonicalField } from '@/lib/dispatch/order-intake';
import { dateOnly } from '@/lib/dispatch/time';
import { isRealIsoDate } from '@/lib/schemas';
import { rateLimit, LIMITS } from '@/lib/rate-limit';
import { clientIp } from '@/lib/client-ip';

// 10 MB / 50k rows / content-type guard (lib/csv), the file read in the parser process (audit P5,
// lib/upload-parse). Unknown customers and products are NOT errors here: they are listed and
// created on confirm, then completed by the dispatcher.

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
  if (deliveryDate && !isRealIsoDate(deliveryDate)) {
    return NextResponse.json({ data: null, error: 'deliveryDate must be a real date as YYYY-MM-DD' }, { status: 400 });
  }

  // Order rows on more than one sheet of a workbook are refused, naming the sheets (scenario test
  // S04 / B2): reading only the first one would drop the others without a word.
  const colMap = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { orderColumnMapJson: true } });
  const extraAliases = (colMap?.orderColumnMapJson ?? {}) as Partial<Record<CanonicalField, string[]>>;
  let parsed;
  try {
    // The order sheet is the one with the order columns (isOrderSheet, the company's aliases too).
    parsed = await parseUploadIsolated(file, { orderSheet: { extraAliases }, rowsWord: 'order' });
  } catch (err) {
    // Too long, too much memory, the reader stopped, or busy (503): nothing was saved.
    if (err instanceof UploadParseRefused) return uploadRefusedResponse(err);
    if (err instanceof MultipleSheetsError) {
      return NextResponse.json({ data: null, error: { code: err.code, message: err.message, sheets: err.sheets } }, { status: 400 });
    }
    return NextResponse.json({ data: null, error: (err as Error).message }, { status: 400 });
  }

  let v;
  try {
    // rowNumbers: the file row of each row (blank rows the reader left out counted), for the messages and OrderLine.sourceRow.
    v = await validateIntake(tenantId, parsed.rows, { depotId, defaultDeliveryDate: deliveryDate, rowNumbers: parsed.rowNumbers });
  } catch (err) {
    // Owner rule (audit PR A5): every order file is for one depot. No active depot, or no choice
    // among two or more, or a chosen depot that is not active: 422, nothing is saved.
    if (err instanceof DepotRequired) return NextResponse.json({ data: null, error: err.body() }, { status: err.status });
    // Anything else is not the file's fault (the database, a bug): plain words and 500, nothing
    // saved; Prisma's text (file paths, code lines) goes only to the server log.
    console.error('[orders-upload] checking the file failed', err);
    return NextResponse.json({ data: null, error: { code: 'CHECK_FAILED', message: INTAKE_CHECK_FAILED } }, { status: 500 });
  }
  // File-level notes (CSV parse warnings, workbook sheets not read) are kept with the check, so
  // the upload page shows them too, not only the answer.
  v.warnings.push(...parsed.warnings);
  const db = tenantDb(tenantId);
  // The hash is of the normalized lines including their delivery dates, in any row or column
  // order (contentFingerprint): the same orders for the same depot and dates, not the same bytes.
  // Batches confirmed before this release stored a hash of the raw rows: that one is checked too
  // (for the same dates), so a file confirmed before the deploy is not added a second time.
  const hash = v.contentHash ?? null;
  v.legacyHash = legacyRowsHash(parsed.rows);
  let batch;
  try {
    const sameFile = await findSameConfirmedFile(prisma, tenantId, {
      depotId: v.depotId,
      contentHash: hash,
      legacyHash: v.legacyHash,
      deliveryDates: v.totals.deliveryDates,
    });
    if (sameFile) {
      v.errors.unshift({
        row: 1,
        // Every line of a re-sent file is skipped, so name the file's own dates (never "this date").
        message: `These orders were already confirmed for ${(v.totals.deliveryDates.length ? v.totals.deliveryDates : v.fileDeliveryDates ?? []).join(', ') || 'this date'} (file ${sameFile.fileName}, ${sameFile.uploadedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC).`,
      });
    }
    const topDate = v.totals.deliveryDates[0] ?? deliveryDate;

    batch = await db.uploadBatch.create({
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
  } catch (err) {
    // As for the check above: the database refused a write (review s5-security-1: a U+0000 in the
    // file, which PostgreSQL cannot store, made this an uncaught error and an EMPTY 500, shown as
    // "HTTP 500"; the parser now takes U+0000 out), or a bug. Plain words and the CHECK_FAILED body;
    // Prisma's text only in the server log. No order is written before confirm, so none was saved.
    console.error('[orders-upload] saving the checked file failed', err);
    return NextResponse.json({ data: null, error: { code: 'CHECK_FAILED', message: INTAKE_CHECK_FAILED } }, { status: 500 });
  }

  return NextResponse.json({
    data: {
      batchId: batch.id,
      validation: {
        totalRows: parsed.rows.length,
        validRows: v.lines.length,
        errorRows: v.errors.length,
        warningRows: v.warnings.length + v.duplicates.length,
        errors: v.errors,
        warnings: [...v.warnings, ...v.duplicates.map((d) => `Row ${d.row}: ${d.message}`)],
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
