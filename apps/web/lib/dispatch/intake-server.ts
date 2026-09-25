/**
 * Server side of order intake: loads master data + already-confirmed lines, runs the pure
 * normalizer/resolver, decides LATE, and (on confirm) writes customers/products/orders.
 */
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { tenantDb } from '../tenant';
import {
  customerKey,
  customerTypeFromText,
  normalizeOrderRows,
  resolveOrderLines,
  type CanonicalField,
  type DateOrder,
  type ResolveResult,
  type ResolvedLine,
} from './order-intake';
import { currentPlan } from './plan-service';
import { dateOnly, isAfterCutoff, isoOf, tomorrowIso } from './time';

export interface IntakeValidation extends ResolveResult {
  depotId: string;
  depotCode: string;
  mapping: Record<string, string>;
  unmappedColumns: string[];
  fileCases: number;
  late: { isLate: boolean; reasons: string[] };
}

export async function defaultDepot(tenantId: string, depotId?: string | null) {
  if (depotId) return prisma.depot.findFirst({ where: { tenantId, id: depotId, active: true } });
  return prisma.depot.findFirst({ where: { tenantId, active: true }, orderBy: { code: 'asc' } });
}

export function fileHash(rows: Record<string, string>[]) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export async function validateIntake(
  tenantId: string,
  rows: Record<string, string>[],
  opts: { depotId?: string | null; defaultDeliveryDate?: string | null; now?: Date },
): Promise<IntakeValidation> {
  const db = tenantDb(tenantId);
  const cfg = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId } });
  const depot = await defaultDepot(tenantId, opts.depotId);
  if (!depot) throw new Error('No active depot. Create a depot first.');
  const extra = (cfg.orderColumnMapJson ?? {}) as Partial<Record<CanonicalField, string[]>>;
  const norm = normalizeOrderRows(rows, {
    defaultDeliveryDate: opts.defaultDeliveryDate || tomorrowIso(cfg.timezone, opts.now),
    dateOrder: (cfg.dateOrder as DateOrder) ?? 'DMY',
    extraAliases: extra,
  });
  const customers = await db.customer.findMany({ select: { id: true, code: true, branchKey: true, name: true, active: true, lat: true, lng: true } });
  const products = await db.product.findMany({ select: { id: true, code: true, name: true, active: true, weightPerCaseKg: true } });
  const dates = [...new Set(norm.lines.map((l) => l.deliveryDate))];
  const confirmed = dates.length
    ? await prisma.orderLine.findMany({
        where: { salesOrderNo: { not: null }, order: { tenantId, deliveryDate: { in: dates.map(dateOnly) } } },
        select: { salesOrderNo: true, product: { select: { code: true } }, order: { select: { deliveryDate: true, customer: { select: { code: true, branchKey: true } } } } },
      })
    : [];
  const already = new Set(
    confirmed.map((l) => `${isoOf(l.order.deliveryDate)}|${l.salesOrderNo}|${customerKey(l.order.customer.code, l.order.customer.branchKey)}|${l.product.code.toUpperCase()}`),
  );
  const res = resolveOrderLines(norm, customers, products, already);

  // Depot column: rows for another depot are an error (they belong to another plan).
  if (norm.mapping.used.depot_code) {
    const bad = res.lines.filter((l) => l.depotCode && l.depotCode.toUpperCase() !== depot.code.toUpperCase());
    for (const l of bad) res.errors.push({ row: l.row, message: `Row is for depot ${l.depotCode}, but you are uploading for ${depot.code}.`, cases: l.cases });
    const badRows = new Set(bad.map((l) => l.row));
    res.lines = res.lines.filter((l) => !badRows.has(l.row));
  }

  const now = opts.now ?? new Date();
  const reasons: string[] = [];
  for (const d of dates) {
    if (isAfterCutoff(now, d, cfg.planningCutoffMin, cfg.timezone)) {
      reasons.push(`Received after the ${String(Math.floor(cfg.planningCutoffMin / 60)).padStart(2, '0')}:${String(cfg.planningCutoffMin % 60).padStart(2, '0')} cutoff for ${d}.`);
    }
    const plan = await currentPlan(tenantId, depot.id, d);
    if (plan?.chosenScenarioId) reasons.push(`A plan (version ${plan.version}) already exists for ${d}.`);
  }
  return {
    ...res,
    errors: res.errors.sort((a, b) => a.row - b.row),
    depotId: depot.id,
    depotCode: depot.code,
    mapping: norm.mapping.used as Record<string, string>,
    unmappedColumns: norm.mapping.unmapped,
    fileCases: norm.fileCases,
    late: { isLate: reasons.length > 0, reasons },
  };
}

/**
 * Confirm a validated batch: create stub customers ("LOCATION REQUIRED") and products, then one
 * Order per customer branch + delivery date (lines keep SO numbers, SKU detail, value, margin).
 */
export async function confirmIntake(
  tx: Prisma.TransactionClient,
  tenantId: string,
  batch: { id: string; depotId: string | null },
  v: IntakeValidation,
  user: { id: string },
  late: { isLate: boolean; reason: string | null },
) {
  const newCustomerIds = new Map<string, string>();
  for (const nc of v.issues.newCustomers) {
    const existing = await tx.customer.findFirst({ where: { tenantId, code: nc.code, branchKey: nc.branchKey } });
    const c =
      existing ??
      (await tx.customer.create({
        data: {
          tenantId,
          code: nc.code,
          branchCode: nc.branchCode,
          branchKey: nc.branchKey,
          name: nc.name,
          customerType: (customerTypeFromText(nc.customerType) as never) ?? undefined,
          createdFromUpload: true,
          geocodeConfidence: 'MISSING',
        },
      }));
    newCustomerIds.set(customerKey(nc.code, nc.branchKey), c.id);
  }
  const newProductIds = new Map<string, string>();
  for (const np of v.issues.newProducts) {
    const existing = await tx.product.findFirst({ where: { tenantId, code: np.code } });
    const p = existing ?? (await tx.product.create({ data: { tenantId, code: np.code, name: np.name, createdFromUpload: true } }));
    newProductIds.set(np.code.toUpperCase(), p.id);
  }
  const productIds = [...new Set(v.lines.map((l) => l.productId).filter(Boolean) as string[]), ...newProductIds.values()];
  const products = await tx.product.findMany({ where: { tenantId, id: { in: productIds } }, select: { id: true, weightPerCaseKg: true, volumePerCaseL: true } });
  const prodById = new Map(products.map((p) => [p.id, p]));

  const groups = new Map<string, (ResolvedLine & { cid: string; pid: string })[]>();
  for (const l of v.lines) {
    const cid = l.customerId ?? newCustomerIds.get(l.customerKey);
    const pid = l.productId ?? newProductIds.get(l.productCode.toUpperCase());
    if (!cid || !pid) throw new Error(`Row ${l.row}: customer/product could not be created.`);
    const k = `${cid}|${l.deliveryDate}`;
    groups.set(k, [...(groups.get(k) ?? []), { ...l, cid, pid }]);
  }
  const customers = await tx.customer.findMany({
    where: { tenantId, id: { in: [...new Set([...groups.values()].map((g) => g[0].cid))] } },
    select: { id: true, priority: true, avgServiceTimeMin: true },
  });
  const custById = new Map(customers.map((c) => [c.id, c]));
  let ordersCreated = 0;
  let linesCreated = 0;
  let cases = 0;
  const now = new Date();
  for (const rows of groups.values()) {
    const first = rows[0];
    const cust = custById.get(first.cid)!;
    const lineData = rows.map((r) => {
      const p = prodById.get(r.pid);
      const weightKg = r.weightKg ?? (p ? p.weightPerCaseKg * r.cases : 0);
      return { r, weightKg, volume: p ? p.volumePerCaseL * r.cases : 0 };
    });
    const filePriorities = rows.map((r) => r.priority).filter((p): p is number => p !== null);
    const allValue = rows.every((r) => r.salesValue !== null);
    const allMargin = rows.every((r) => r.margin !== null);
    const order = await tx.order.create({
      data: {
        tenantId,
        customerId: first.cid,
        depotId: batch.depotId,
        deliveryDate: dateOnly(first.deliveryDate),
        totalCases: rows.reduce((a, r) => a + r.cases, 0),
        totalWeightKg: lineData.reduce((a, x) => a + x.weightKg, 0),
        totalVolumeL: lineData.reduce((a, x) => a + x.volume, 0),
        totalServiceTimeMin: Math.max(cust.avgServiceTimeMin, 1),
        priority: filePriorities.length ? Math.min(...filePriorities) : cust.priority,
        priorityFromFile: filePriorities.length > 0,
        // Each distinct remark once: the same note usually repeats on every line of an order.
        notes: [...new Set(rows.map((r) => r.notes?.trim()).filter(Boolean))].join(' | ') || null,
        status: 'VALIDATED',
        uploadBatchId: batch.id,
        uploadedAt: now,
        isLate: late.isLate,
        lateReason: late.isLate ? late.reason : null,
        lateRecordedById: late.isLate ? user.id : null,
        salesValue: allValue ? rows.reduce((a, r) => a + (r.salesValue ?? 0), 0) : null,
        marginValue: allMargin ? rows.reduce((a, r) => a + (r.margin ?? 0), 0) : null,
      },
    });
    await tx.orderLine.createMany({
      data: lineData.map(({ r, weightKg }) => ({
        orderId: order.id,
        productId: r.pid,
        cases: r.cases,
        salesOrderNo: r.salesOrderNo,
        orderDate: r.orderDate ? dateOnly(r.orderDate) : null,
        productDescription: r.productDescription,
        weightKg,
        salesValue: r.salesValue,
        marginValue: r.margin,
        sourceRow: r.row,
        notes: r.notes,
      })),
    });
    ordersCreated++;
    linesCreated += rows.length;
    cases += rows.reduce((a, r) => a + r.cases, 0);
  }
  return { ordersCreated, linesCreated, cases, customersCreated: v.issues.newCustomers.length, productsCreated: v.issues.newProducts.length };
}
