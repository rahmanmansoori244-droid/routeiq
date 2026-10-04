/**
 * Server side of order intake: loads master data + already-confirmed lines, runs the pure
 * normalizer/resolver, decides LATE, and (on confirm) re-checks everything under a per-tenant
 * lock and writes customers/products/orders plus one IntakeLineKey per sales-order line.
 */
import { createHash } from 'node:crypto';
import type { Prisma, TenantConfig } from '@prisma/client';
import { prisma } from '../db';
import { tenantDb } from '../tenant';
import {
  contentFingerprint,
  customerKey,
  customerTypeFromText,
  joinNotes,
  lineDupKey,
  normalizeOrderRows,
  normSalesOrder,
  preferredCustomer,
  preferredProduct,
  resolveOrderLines,
  type CanonicalField,
  type DateOrder,
  type ResolveResult,
  type ResolvedLine,
} from './order-intake';
import { normalizeProductCode, productKey, twinsOf } from '../product-code';
import { currentPlan } from './plan-service';
import { intakeLineWeight } from './weights';
import { dateOnly, isAfterCutoff, isoOf, tomorrowIso } from './time';

type Tx = Prisma.TransactionClient;

export interface IntakeValidation extends ResolveResult {
  depotId: string;
  depotCode: string;
  mapping: Record<string, string>;
  unmappedColumns: string[];
  fileCases: number;
  late: { isLate: boolean; reasons: string[] };
  /** Every delivery date in the file, skipped lines included (totals.deliveryDates: the lines to add). */
  fileDeliveryDates?: string[];
  /** SHA-256 of the file's normalized content (contentFingerprint): stored as UploadBatch.fileHash. */
  contentHash?: string;
  /**
   * SHA-256 of the raw rows as read (legacyRowsHash): the file hash that batches confirmed before
   * the stabilization release stored. Checked too, so a file confirmed before that deploy cannot
   * be confirmed again after it (rows without a sales order have no IntakeLineKey to stop them).
   */
  legacyHash?: string;
}

/** A checked file older than this must be uploaded again before it can be confirmed. */
export const VALIDATED_BATCH_MAX_AGE_HOURS = 24;

/** A confirm that would no longer be correct: answered with `status` and `code`, nothing saved. */
export class IntakeConflict extends Error {
  constructor(
    public code: 'DUPLICATE_LINES' | 'DUPLICATE_FILE' | 'MASTER_CHANGED' | 'LATE_REASON_REQUIRED' | 'STALE_VALIDATION',
    message: string,
    public status = 409,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
  body(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

/**
 * Serializes intake writes of one tenant (confirm, late order, batch delete) for the rest of
 * the transaction. Volumes are tiny, so one lock per tenant is enough.
 */
export async function lockIntake(tx: Tx, tenantId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`intake:${tenantId}`}, 0))`;
}

/**
 * True for Prisma's interactive-transaction timeout (P2028: could not start within maxWait, or
 * ran past timeout) - e.g. waiting for the intake lock while a large file is being confirmed.
 */
export function isTransactionTimeout(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'P2028';
}

/** The 409 answer when the intake lock (or the transaction) timed out: nothing was saved. */
export const INTAKE_BUSY = {
  error: 'Another order file or late order is being added for this company right now. Nothing was saved: try again in a moment.',
  code: 'INTAKE_BUSY',
} as const;

/**
 * The answer when checking an order file failed for a reason that is not the file's (the database,
 * a bug): 500, nothing saved. The details go only to the server log (before, the route answered
 * Prisma's own text, file paths and code lines included; third review of audit P5).
 */
export const INTAKE_CHECK_FAILED =
  'RouteIQ could not check this file. Nothing was saved. Try again in a moment. If it happens again, tell your administrator.';

/**
 * PostgreSQL takes at most 32,767 bind parameters in one query, and Prisma does not split an `in`
 * list that comes with other conditions (it fails with P2035 or P2029). An order file may hold
 * 50,000 rows, so a list that grows with the file is asked for in parts of this many values (third
 * review of audit P5: a file of 32,766 or more sales orders was refused with Prisma's text).
 */
export const IN_LIST_PART = 10_000;

/** `values` in order, in parts of at most `size` (see IN_LIST_PART). */
export function inParts<T>(values: readonly T[], size = IN_LIST_PART): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < values.length; i += size) parts.push(values.slice(i, i + size));
  return parts;
}

/** An order file that cannot be linked to a depot (owner rule, audit PR A5): 422, nothing saved. */
export class DepotRequired extends Error {
  readonly status = 422;
  constructor(
    public code: 'DEPOT_REQUIRED' | 'DEPOT_NOT_ACTIVE',
    message: string,
  ) {
    super(message);
  }
  body(): Record<string, unknown> {
    return { code: this.code, message: this.message };
  }
}

export const NO_ACTIVE_DEPOT =
  'There is no active depot, so these orders cannot be linked to one. Add a depot under Depots, then upload the file again.';
export const CHOOSE_DEPOT =
  'This company has more than one depot. Upload the file on the Daily dispatch screen after choosing its depot, so every order is linked to the right depot.';
export const DEPOT_NOT_ACTIVE =
  'The depot chosen for this file is not active. Choose an active depot on the Daily dispatch screen, then upload the file again.';

/**
 * The depot an order file is for. Owner rule of 27 Sep 2026 (audit PR A5): "all orders must have
 * depots linked to them", so a file is never linked to a depot nobody chose. The depot chosen on
 * the dispatch screen must be an active depot of this company. Without a choice (the older Upload
 * orders page sends none) the company's only active depot is used; with none, or with two or more,
 * the file is refused (DEPOT_REQUIRED). Before, the first active depot by code was taken.
 */
export async function intakeDepot(tenantId: string, depotId?: string | null) {
  if (depotId) {
    const depot = await prisma.depot.findFirst({ where: { tenantId, id: depotId, active: true } });
    if (!depot) throw new DepotRequired('DEPOT_NOT_ACTIVE', DEPOT_NOT_ACTIVE);
    return depot;
  }
  const active = await prisma.depot.findMany({ where: { tenantId, active: true }, orderBy: { code: 'asc' }, take: 2 });
  if (active.length === 1) return active[0];
  throw new DepotRequired('DEPOT_REQUIRED', active.length ? CHOOSE_DEPOT : NO_ACTIVE_DEPOT);
}

/** SHA-256 of an order-insensitive text (see contentFingerprint). */
export function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

/** The raw-row file hash used before the stabilization release (see IntakeValidation.legacyHash). */
export function legacyRowsHash(rows: Record<string, string>[]): string {
  return sha256(JSON.stringify(rows));
}

/**
 * A CONFIRMED batch of this depot with the same orders: the same normalized content (this
 * release's fileHash), or - for batches confirmed before it - the same raw rows for one of the
 * same delivery dates.
 */
export async function findSameConfirmedFile(
  db: Tx | typeof prisma,
  tenantId: string,
  q: { depotId: string; contentHash: string | null; legacyHash: string | null; deliveryDates: string[]; excludeBatchId?: string },
): Promise<{ fileName: string; uploadedAt: Date } | null> {
  const or: Prisma.UploadBatchWhereInput[] = [];
  if (q.contentHash) or.push({ fileHash: q.contentHash });
  if (q.legacyHash && q.deliveryDates.length) or.push({ fileHash: q.legacyHash, deliveryDate: { in: q.deliveryDates.map(dateOnly) } });
  if (!or.length) return null;
  return db.uploadBatch.findFirst({
    where: { tenantId, status: 'CONFIRMED', depotId: q.depotId, OR: or, ...(q.excludeBatchId ? { id: { not: q.excludeBatchId } } : {}) },
    select: { fileName: true, uploadedAt: true },
  });
}

/** Confirmed sales-order lines for these delivery dates, keyed by lineDupKey -> case quantities. */
async function confirmedLineMap(db: Tx | typeof prisma, tenantId: string, dates: string[]): Promise<Map<string, number[]>> {
  if (!dates.length) return new Map();
  const rows = await db.orderLine.findMany({
    where: { salesOrderNo: { not: null }, order: { tenantId, deliveryDate: { in: dates.map(dateOnly) } } },
    select: { salesOrderNo: true, cases: true, product: { select: { code: true } }, order: { select: { deliveryDate: true, customer: { select: { code: true, branchKey: true } } } } },
  });
  const m = new Map<string, number[]>();
  for (const l of rows) {
    if (!normSalesOrder(l.salesOrderNo)) continue;
    const k = lineDupKey(isoOf(l.order.deliveryDate), l.salesOrderNo as string, customerKey(l.order.customer.code, l.order.customer.branchKey), l.product.code);
    m.set(k, [...(m.get(k) ?? []), l.cases]);
  }
  return m;
}

/**
 * The late reason of a day that already has a plan in use: its version and, when there are any,
 * the loads already on their way or locked (the new orders are planned around those).
 */
export function planExistsReason(version: number, date: string, loads: { dispatched: number; locked: number } = { dispatched: 0, locked: 0 }): string {
  const parts: string[] = [];
  if (loads.dispatched) parts.push(`${loads.dispatched} of its loads ${loads.dispatched === 1 ? 'is' : 'are'} dispatched`);
  if (loads.locked) parts.push(`${loads.locked} ${loads.locked === 1 ? 'is' : 'are'} locked or loading`);
  return `A plan (version ${version}) already exists for ${date}${parts.length ? ` (${parts.join(', ')})` : ''}.`;
}

/**
 * The LATE_REASON_REQUIRED message: the real reason(s) the orders count as late - received after
 * the planning cutoff, or the day already has a plan (with loads dispatched) - never "after the
 * cutoff" for a day that only has a plan (scenario test S04). `sinceCheck`: the file was not late
 * when it was checked and became late before the confirm.
 */
export function lateReasonRequiredMessage(reasons: string[], opts: { sinceCheck?: boolean } = {}): string {
  const why = reasons.length ? reasons.join(' ') : 'They were received after the planning cutoff, or the day already has a plan.';
  return `${opts.sinceCheck ? 'These orders became late after the file was checked.' : 'These orders are late.'} ${why} Enter the reason for accepting them.`;
}

/** Why orders for these dates are late now: after the cutoff, or a plan is already in use. */
async function lateReasons(tenantId: string, cfg: Pick<TenantConfig, 'planningCutoffMin' | 'timezone'>, depotId: string, dates: string[], now: Date) {
  const reasons: string[] = [];
  for (const d of dates) {
    if (isAfterCutoff(now, d, cfg.planningCutoffMin, cfg.timezone)) {
      reasons.push(`Received after the ${String(Math.floor(cfg.planningCutoffMin / 60)).padStart(2, '0')}:${String(cfg.planningCutoffMin % 60).padStart(2, '0')} cutoff for ${d}.`);
    }
    const plan = await currentPlan(tenantId, depotId, d);
    if (plan?.chosenScenarioId) {
      const started = await prisma.planLoad.findMany({
        where: { tenantId, runId: plan.id, status: { in: ['LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED'] } },
        select: { status: true },
      });
      const dispatched = started.filter((l) => l.status === 'DISPATCHED' || l.status === 'COMPLETED').length;
      reasons.push(planExistsReason(plan.version, d, { dispatched, locked: started.length - dispatched }));
    }
  }
  return reasons;
}

export async function validateIntake(
  tenantId: string,
  rows: Record<string, string>[],
  opts: { depotId?: string | null; defaultDeliveryDate?: string | null; now?: Date },
): Promise<IntakeValidation> {
  const db = tenantDb(tenantId);
  const cfg = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId } });
  const depot = await intakeDepot(tenantId, opts.depotId);
  const extra = (cfg.orderColumnMapJson ?? {}) as Partial<Record<CanonicalField, string[]>>;
  const norm = normalizeOrderRows(rows, {
    defaultDeliveryDate: opts.defaultDeliveryDate || tomorrowIso(cfg.timezone, opts.now),
    dateOrder: (cfg.dateOrder as DateOrder) ?? 'DMY',
    extraAliases: extra,
  });
  const customers = await db.customer.findMany({ select: { id: true, code: true, branchKey: true, name: true, active: true, lat: true, lng: true } });
  const products = await db.product.findMany({ select: { id: true, code: true, name: true, active: true, weightPerCaseKg: true } });
  const dates = [...new Set(norm.lines.map((l) => l.deliveryDate))];
  const already = await confirmedLineMap(prisma, tenantId, dates);
  // The same sales orders confirmed for other delivery dates (warning only). Asked for in parts
  // (IN_LIST_PART), and the file's own dates are left out here rather than in the query, so no
  // query passes PostgreSQL's 32,767 bind parameters however many sales orders or dates the file has.
  const fileSos = [...new Set(norm.lines.map((l) => normSalesOrder(l.salesOrderNo)).filter((s): s is string => !!s))];
  const custById = new Map(customers.map((c) => [c.id, c]));
  const otherDates = new Map<string, string[]>();
  const fileDates = new Set(dates);
  for (const part of inParts(fileSos)) {
    const keys = await prisma.intakeLineKey.findMany({
      where: { tenantId, salesOrderNorm: { in: part } },
      select: { salesOrderNorm: true, customerId: true, deliveryDate: true },
    });
    for (const k of keys) {
      const date = isoOf(k.deliveryDate);
      if (fileDates.has(date)) continue;
      const c = custById.get(k.customerId);
      if (!c) continue;
      const key = `${k.salesOrderNorm}|${customerKey(c.code, c.branchKey)}`;
      otherDates.set(key, [...(otherDates.get(key) ?? []), date]);
    }
  }
  const res = resolveOrderLines(norm, customers, products, already, { confirmedOnOtherDates: otherDates });

  // Depot column: rows for another depot are an error (they belong to another plan).
  if (norm.mapping.used.depot_code) {
    const bad = res.lines.filter((l) => l.depotCode && l.depotCode.toUpperCase() !== depot.code.toUpperCase());
    for (const l of bad) res.errors.push({ row: l.row, message: `Row is for depot ${l.depotCode}, but you are uploading for ${depot.code}.`, cases: l.cases });
    const badRows = new Set(bad.map((l) => l.row));
    res.lines = res.lines.filter((l) => !badRows.has(l.row));
  }

  const reasons = await lateReasons(tenantId, cfg, depot.id, dates, opts.now ?? new Date());
  return {
    ...res,
    errors: res.errors.sort((a, b) => a.row - b.row),
    depotId: depot.id,
    depotCode: depot.code,
    mapping: norm.mapping.used as Record<string, string>,
    unmappedColumns: norm.mapping.unmapped,
    fileCases: norm.fileCases,
    late: { isLate: reasons.length > 0, reasons },
    fileDeliveryDates: [...dates].sort(),
    contentHash: sha256(contentFingerprint(norm.lines)),
  };
}

/** STALE_VALIDATION message for a file checked before merged rows kept every priority and note. */
export const MERGED_THE_OLD_WAY =
  'This file was checked before RouteIQ kept the highest priority and every note of rows with the same sales order and product. Nothing was added: upload the file again so those rows are added together the new way.';

/**
 * A batch checked before this release with a line added together from several rows: that line
 * kept only its first row's priority and note and could count blank money as 0 (audit F02 /
 * F04). Its stored line cannot be repaired, so the file must be uploaded again.
 */
export function mergedTheOldWay(lines: Pick<ResolvedLine, 'sourceRows' | 'mergedRows'>[]): boolean {
  return lines.some((l) => (l.sourceRows?.length ?? 1) > 1 && !l.mergedRows);
}

/**
 * Why a checked file can no longer be confirmed for its depot (audit F03), or null: the depot
 * was deactivated after the check, or is not found. Every file has a depot (audit PR A5); a file
 * that had none before that rule is on the company's history-only depot, which never gets orders.
 */
export function batchDepotProblem(depot: { code: string; active: boolean; historyOnly?: boolean } | null): string | null {
  if (!depot) return 'The depot of this file was deleted after the file was checked. Nothing was added: upload the file again for an active depot.';
  if (depot.historyOnly) {
    return 'This file was checked before every order file had a depot. Nothing was added: upload the file again on the Daily dispatch screen for an active depot.';
  }
  if (!depot.active) {
    return `Depot ${depot.code} was deactivated after this file was checked. Nothing was added: reactivate the depot under Depots, or upload the file again for another depot.`;
  }
  return null;
}

/**
 * Re-check a validated batch inside the confirm transaction (after lockIntake), because the
 * world may have changed since the file was checked: another file or a late order confirmed
 * the same lines, the same file was confirmed, a customer or product was deactivated or
 * deleted, the cutoff passed or a plan was applied. Throws IntakeConflict; returns the late
 * state to confirm with.
 */
export async function revalidateIntake(
  tx: Tx,
  tenantId: string,
  batch: { id: string; depotId: string; uploadedAt: Date; fileHash: string | null },
  v: IntakeValidation,
  now: Date,
): Promise<{ isLate: boolean; reasons: string[] }> {
  const ageH = (now.getTime() - batch.uploadedAt.getTime()) / 3_600_000;
  if (ageH > VALIDATED_BATCH_MAX_AGE_HOURS) {
    throw new IntakeConflict(
      'STALE_VALIDATION',
      `This file was checked more than ${VALIDATED_BATCH_MAX_AGE_HOURS} hours ago. Upload it again so it is checked against today's orders and master data.`,
    );
  }
  if (mergedTheOldWay(v.lines)) {
    throw new IntakeConflict('STALE_VALIDATION', MERGED_THE_OLD_WAY);
  }
  {
    // The depot is locked (FOR SHARE) until the orders are written: a depot deactivated or deleted
    // after the check never receives them (audit F03), and one being deactivated right now is waited for.
    const depot = await tx.$queryRaw<Array<{ code: string; active: boolean; historyOnly: boolean }>>`
      SELECT "code", "active", "historyOnly" FROM "Depot" WHERE "id" = ${batch.depotId} AND "tenantId" = ${tenantId} FOR SHARE`;
    const problem = batchDepotProblem(depot[0] ?? null);
    if (problem) throw new IntakeConflict('MASTER_CHANGED', problem);
  }
  {
    const same = await findSameConfirmedFile(tx, tenantId, {
      depotId: batch.depotId,
      contentHash: batch.fileHash,
      legacyHash: v.legacyHash ?? null,
      deliveryDates: v.totals.deliveryDates,
      excludeBatchId: batch.id,
    });
    if (same) {
      throw new IntakeConflict('DUPLICATE_FILE', `The same orders were already confirmed from ${same.fileName} (${same.uploadedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC). Nothing was added.`);
    }
  }
  const already = await confirmedLineMap(tx, tenantId, v.totals.deliveryDates);
  const dup = v.lines.filter((l) => l.salesOrderNo && already.has(lineDupKey(l.deliveryDate, l.salesOrderNo, l.customerKey, l.productCode)));
  if (dup.length) {
    const rows = dup.flatMap((l) => l.sourceRows ?? [l.row]).sort((a, b) => a - b);
    throw new IntakeConflict(
      'DUPLICATE_LINES',
      `${dup.length} line(s) of this file were confirmed from another file or a late order after it was checked (row${rows.length > 1 ? 's' : ''} ${rows.slice(0, 20).join(', ')}${rows.length > 20 ? ', ...' : ''}). Upload the file again: lines already confirmed are then skipped.`,
      409,
      { rows },
    );
  }
  const custIds = [...new Set(v.lines.map((l) => l.customerId).filter((x): x is string => !!x))];
  const prodIds = [...new Set(v.lines.map((l) => l.productId).filter((x): x is string => !!x))];
  const custs = custIds.length ? await tx.customer.findMany({ where: { tenantId, id: { in: custIds } }, select: { id: true, code: true, branchCode: true, active: true } }) : [];
  const prods = prodIds.length ? await tx.product.findMany({ where: { tenantId, id: { in: prodIds } }, select: { id: true, code: true, active: true } }) : [];
  const custOk = new Map(custs.map((c) => [c.id, c]));
  const prodOk = new Map(prods.map((p) => [p.id, p]));
  const changed: string[] = [];
  for (const l of v.lines) {
    const c = l.customerId ? custOk.get(l.customerId) : undefined;
    if (l.customerId && !c) changed.push(`customer ${l.customerCode} was deleted`);
    else if (c && !c.active) changed.push(`customer ${c.code}${c.branchCode ? ` / ${c.branchCode}` : ''} was deactivated`);
    const p = l.productId ? prodOk.get(l.productId) : undefined;
    if (l.productId && !p) changed.push(`product ${l.productCode} was deleted`);
    else if (p && !p.active) changed.push(`product ${p.code} was deactivated`);
  }
  if (changed.length) {
    const list = [...new Set(changed)];
    throw new IntakeConflict('MASTER_CHANGED', `Master data changed after this file was checked: ${list.slice(0, 8).join('; ')}${list.length > 8 ? '; ...' : ''}. Upload the file again.`, 409, { changes: list });
  }
  const cfg = await tx.tenantConfig.findUniqueOrThrow({ where: { tenantId }, select: { planningCutoffMin: true, timezone: true } });
  const reasons = await lateReasons(tenantId, cfg, batch.depotId, v.totals.deliveryDates, now);
  const all = [...new Set([...(v.late?.reasons ?? []), ...reasons])];
  return { isLate: !!v.late?.isLate || reasons.length > 0, reasons: all };
}

/**
 * Confirm a validated batch: create stub customers ("LOCATION REQUIRED") and products, then one
 * Order per customer branch + delivery date (lines keep SO numbers, SKU detail, value, margin),
 * and one IntakeLineKey per sales-order line (a unique index: the same line twice fails).
 */
export async function confirmIntake(
  tx: Prisma.TransactionClient,
  tenantId: string,
  batch: { id: string; depotId: string },
  v: IntakeValidation,
  user: { id: string },
  late: { isLate: boolean; reason: string | null },
) {
  const newCustomerIds = new Map<string, string>();
  for (const nc of v.issues.newCustomers) {
    // Case-insensitive, like the file intake: a customer created meanwhile as "c001" is reused.
    const twins = await tx.customer.findMany({
      where: { tenantId, code: { equals: nc.code, mode: 'insensitive' }, branchKey: { equals: nc.branchKey, mode: 'insensitive' } },
      select: { id: true, code: true, branchCode: true, active: true, lat: true, lng: true },
    });
    const existing = preferredCustomer(twins);
    if (existing && !existing.active) {
      throw new IntakeConflict('MASTER_CHANGED', `Customer ${existing.code}${existing.branchCode ? ` / ${existing.branchCode}` : ''} was added and deactivated after this file was checked. Upload the file again.`);
    }
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
  if (v.issues.newProducts.length) {
    // The company's products once, matched on the code in the program (productKey: letter case and
    // spacing, "_" is a letter): the database's case-insensitive equals is an ILIKE, which read "_"
    // as "any character". A product made below is added, so another spelling of it reuses it.
    const master = await tx.product.findMany({ where: { tenantId }, select: { id: true, code: true, active: true, weightPerCaseKg: true } });
    for (const np of v.issues.newProducts) {
      const code = normalizeProductCode(np.code);
      const existing = preferredProduct(twinsOf(master, code));
      if (existing && !existing.active) {
        throw new IntakeConflict('MASTER_CHANGED', `Product ${existing.code} was added and deactivated after this file was checked. Upload the file again.`);
      }
      // A new product starts at 0 kg per case = unknown weight (Products page, or the next optimize asks).
      const p = existing ?? (await tx.product.create({ data: { tenantId, code, name: np.name, createdFromUpload: true } }));
      if (!existing) master.push({ id: p.id, code: p.code, active: true, weightPerCaseKg: 0 });
      newProductIds.set(productKey(np.code), p.id);
    }
  }
  const productIds = [...new Set(v.lines.map((l) => l.productId).filter(Boolean) as string[]), ...newProductIds.values()];
  const products = await tx.product.findMany({ where: { tenantId, id: { in: productIds } }, select: { id: true, weightPerCaseKg: true, volumePerCaseL: true } });
  const prodById = new Map(products.map((p) => [p.id, p]));

  const groups = new Map<string, (ResolvedLine & { cid: string; pid: string })[]>();
  for (const l of v.lines) {
    const cid = l.customerId ?? newCustomerIds.get(l.customerKey);
    const pid = l.productId ?? newProductIds.get(productKey(l.productCode));
    if (!cid || !pid) throw new Error(`Row ${l.row}: customer/product could not be created.`);
    const k = `${cid}|${l.deliveryDate}`;
    // Added to the group's list in place: copying the list for every line took 5-40 s for one
    // customer's 40,000 lines, and the confirm's transaction has 60 s (third review of audit P5).
    const group = groups.get(k);
    if (group) group.push({ ...l, cid, pid });
    else groups.set(k, [{ ...l, cid, pid }]);
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
      // The file kg when every row of the line had one; else weighed from the product master
      // (0 kg = unknown until it has a case weight), following later corrections of it.
      const w = intakeLineWeight(r, p ? p.weightPerCaseKg : 0);
      return { r, weightKg: w.weightKg, fromMaster: w.fromMaster, volume: p ? p.volumePerCaseL * r.cases : 0 };
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
        // Each distinct remark once: the same note usually repeats on every line of an order, and a
        // line added together from several rows already holds each of its rows' notes (audit F02).
        notes: joinNotes(...rows.map((r) => r.notes)),
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
      data: lineData.map(({ r, weightKg, fromMaster }) => ({
        orderId: order.id,
        productId: r.pid,
        cases: r.cases,
        salesOrderNo: r.salesOrderNo,
        orderDate: r.orderDate ? dateOnly(r.orderDate) : null,
        productDescription: r.productDescription,
        weightKg,
        weightFromMaster: fromMaster,
        salesValue: r.salesValue,
        marginValue: r.margin,
        sourceRow: r.row,
        notes: r.notes,
      })),
    });
    await createIntakeKeys(tx, tenantId, order.id, first.cid, order.deliveryDate, batch.id);
    ordersCreated++;
    linesCreated += rows.length;
    cases += rows.reduce((a, r) => a + r.cases, 0);
  }
  return { ordersCreated, linesCreated, cases, customersCreated: v.issues.newCustomers.length, productsCreated: v.issues.newProducts.length };
}

/**
 * One IntakeLineKey per sales-order line of an order, in the caller's transaction. The unique
 * index makes a second confirm of the same line fail (Prisma P2002), whatever path it came by.
 */
export async function createIntakeKeys(tx: Tx, tenantId: string, orderId: string, customerId: string, deliveryDate: Date, uploadBatchId: string | null) {
  const lines = await tx.orderLine.findMany({ where: { orderId }, select: { id: true, salesOrderNo: true, productId: true } });
  const data = lines.flatMap((l) => {
    const so = normSalesOrder(l.salesOrderNo);
    return so ? [{ tenantId, deliveryDate, salesOrderNorm: so, customerId, productId: l.productId, orderLineId: l.id, uploadBatchId }] : [];
  });
  if (data.length) await tx.intakeLineKey.createMany({ data });
}

/** True for the unique-index error of IntakeLineKey (a line confirmed twice). */
export function isIntakeKeyConflict(e: unknown): boolean {
  const err = e as { code?: string; meta?: { target?: unknown; modelName?: string } } | null;
  if (!err || err.code !== 'P2002') return false;
  const target = err.meta?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return err.meta?.modelName === 'IntakeLineKey' || /salesOrderNorm|orderLineId|IntakeLineKey/.test(text);
}
