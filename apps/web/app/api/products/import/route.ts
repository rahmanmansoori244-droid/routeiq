import { withTenantApi, ok, fail } from '@/lib/api';
import { audit } from '@/lib/audit';
import { LIMITS } from '@/lib/rate-limit';
import { parseUploadIsolated, UploadParseRefused, uploadRefusedResponse } from '@/lib/upload-parse';
import { planProductImport, productsStillWithoutFactor, readProductRows } from '@/lib/dispatch/product-import';

// Products import (owner decision 4 Oct 2026, truck capacity in pallets): the ERP product master -
// code, name, weight per case, cases per pallet, active - in one file (lib/dispatch/product-import.ts
// has the rules). Company admins only, like editing a product. Per CLAUDE.md §15: 10 MB / 50k rows /
// content-type guard, read in the parser process (lib/upload-parse). "Validate only" (dryRun=1)
// writes nothing; a file with an error imports nothing. Each product created or changed gets its own
// audit row (CREATE / UPDATE, what it was and became), and the import one PRODUCTS_IMPORTED row.
export const POST = withTenantApi(
  async (req, { db, user, ip }) => {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return fail('No file uploaded', 400);
    const dryRun = form.get('dryRun') === '1';

    let parsed;
    try {
      parsed = await parseUploadIsolated(file);
    } catch (err) {
      // Too long, too much memory, the reader stopped, or busy (503): nothing was saved.
      if (err instanceof UploadParseRefused) return uploadRefusedResponse(err);
      return fail((err as Error).message, 400);
    }

    const read = readProductRows(parsed.rows);
    const existing = await db.product.findMany({ select: { id: true, code: true, name: true, weightPerCaseKg: true, casesPerPallet: true, active: true } });
    const planned = planProductImport(read.rows, existing);
    const errors = [...read.errors, ...planned.errors].sort((a, b) => a.row - b.row);
    const creates = planned.changes.filter((c) => c.kind === 'CREATE').length;
    const updates = planned.changes.filter((c) => c.kind === 'UPDATE').length;
    const unchanged = planned.changes.filter((c) => c.kind === 'UNCHANGED').length;
    const factorsSet = planned.changes.filter((c) => (c.kind === 'CREATE' ? c.data.casesPerPallet !== null : c.kind === 'UPDATE' && 'casesPerPallet' in c.data)).length;
    const withoutFactor = productsStillWithoutFactor(existing, planned.changes);
    const warnings = [
      ...parsed.warnings,
      ...(read.unreadColumns.length ? [`Columns not read: ${read.unreadColumns.join(', ')}.`] : []),
      ...(read.columns.includes('casesPerPallet') ? [] : ['The file has no cases per pallet column: pallet factors are unchanged.']),
      ...(withoutFactor.length
        ? [
            `${withoutFactor.length} active product(s) ${dryRun || errors.length ? 'would still have' : 'still have'} no cases per pallet: ${withoutFactor.slice(0, 20).join(', ')}${withoutFactor.length > 20 ? ` and ${withoutFactor.length - 20} more` : ''}. Trucks with bays cannot plan a day with them on its orders.`,
          ]
        : []),
    ];
    const answer = {
      fileName: parsed.fileName,
      totalRows: parsed.rows.length,
      validRows: read.rows.length - planned.errors.length,
      errorRows: errors.length,
      warningRows: warnings.length,
      creates,
      updates,
      unchanged,
      factorsSet,
      productsWithoutFactor: withoutFactor,
      errors,
      warnings,
      dryRun,
      imported: 0,
    };
    // Validate only, or a file with an error: nothing is written.
    if (dryRun || errors.length) return ok(answer);

    for (const c of planned.changes) {
      if (c.kind === 'CREATE') {
        const created = await db.product.create({ data: { tenantId: user.tenantId, ...c.data } });
        await audit({ tenantId: user.tenantId, userId: user.id, action: 'CREATE', entity: 'Product', entityId: created.id, afterJson: { ...c.data, source: 'IMPORT', fileName: parsed.fileName } as never, ip });
      } else if (c.kind === 'UPDATE') {
        await db.product.update({ where: { id: c.id }, data: c.data });
        await audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'UPDATE',
          entity: 'Product',
          entityId: c.id,
          beforeJson: c.before as never,
          afterJson: { ...c.data, source: 'IMPORT', fileName: parsed.fileName } as never,
          ip,
        });
      }
    }
    await audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'PRODUCTS_IMPORTED',
      entity: 'Product',
      entityId: null,
      afterJson: { fileName: parsed.fileName, rows: parsed.rows.length, creates, updates, unchanged, factorsSet, withoutFactor: withoutFactor.length } as never,
      ip,
    });
    return ok({ ...answer, imported: creates + updates });
  },
  { role: 'TENANT_ADMIN', rateLimitKey: 'products-import', rateLimitLimit: LIMITS.ordersUpload.limit, rateLimitWindowMs: LIMITS.ordersUpload.windowMs },
);
