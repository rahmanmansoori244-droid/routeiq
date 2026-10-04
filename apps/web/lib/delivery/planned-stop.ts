/**
 * The planned facts of one physical stop (owner request 4 Oct 2026, spec section 8.5): the lines on
 * the truck (the same rowLines helper the plan detail and the driver sheet use, so they cannot drift),
 * the pin, the window, the planned ETA and unloading, and the customer. Read from the live load's
 * RouteAssignment rows at that sequence. Server only.
 */
import type { Prisma } from '@prisma/client';
import { rowLines } from '../dispatch/split';
import { parseLoadBreak, readStopSnapshot } from '../dispatch/snapshots';
import type { VisitLine } from './visit';

export interface PlannedOrder {
  orderId: string;
  carriedToOrderId: string | null;
}

export interface PlannedStop {
  customerId: string;
  customerCode: string;
  customerName: string;
  /** The planned pin (snapshot), else the customer's pin; null = none. */
  pin: { lat: number; lng: number } | null;
  windowStartMin: number | null;
  windowEndMin: number | null;
  etaMin: number | null;
  /** departureMin - serviceStartMin: the scheduled unloading. */
  plannedServiceMin: number | null;
  lines: VisitLine[];
  casesPlanned: number;
  orders: PlannedOrder[];
  /** The load's planned driver break (local minutes), null = none. */
  breakMin: { startMin: number; endMin: number } | null;
}

type Db = Prisma.TransactionClient;

interface AssignmentRow {
  orderId: string;
  orderInStop: number;
  etaMin: number | null;
  serviceStartMin: number | null;
  departureMin: number | null;
  portionLinesJson: unknown;
  stopSnapshotJson: unknown;
  order: {
    id: string;
    customerId: string;
    carriedToOrderId?: string | null;
    customer?: { code?: string; name?: string; lat?: number | null; lng?: number | null } | null;
    lines: { id: string; cases: number; weightKg: number; product?: { code: string } | null }[];
  };
}

/** The planned stop from its plan rows (pure: tests feed rows). Null without rows. */
export function plannedStopFromRows(rows: readonly AssignmentRow[], breakJson: unknown): PlannedStop | null {
  const sorted = [...rows].sort((a, b) => a.orderInStop - b.orderInStop);
  const first = sorted[0];
  if (!first) return null;
  const snap = sorted.map((r) => readStopSnapshot(r.stopSnapshotJson)).find((s) => !!s) ?? null;
  const cust = first.order.customer ?? null;
  const lat = snap ? snap.lat : (cust?.lat ?? null);
  const lng = snap ? snap.lng : (cust?.lng ?? null);
  const promised = snap?.promised ?? null;
  const lines: VisitLine[] = [];
  for (const r of sorted) {
    for (const l of rowLines(r.order.lines, r.portionLinesJson)) {
      lines.push({ orderId: r.orderId, lineId: l.id, productCode: l.product?.code ?? '', plannedCases: l.cases, deliveredCases: null });
    }
  }
  const brk = parseLoadBreak(breakJson);
  const orders = new Map<string, PlannedOrder>();
  for (const r of sorted) orders.set(r.orderId, { orderId: r.orderId, carriedToOrderId: r.order.carriedToOrderId ?? null });
  return {
    customerId: first.order.customerId,
    customerCode: snap?.code || cust?.code || '',
    customerName: snap?.name || cust?.name || '',
    pin: lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
    windowStartMin: promised ? promised.startMin : (snap?.hardStartMin ?? null),
    windowEndMin: promised ? promised.endMin : (snap?.hardEndMin ?? null),
    etaMin: first.etaMin,
    plannedServiceMin: first.departureMin !== null && first.serviceStartMin !== null ? first.departureMin - first.serviceStartMin : null,
    lines,
    casesPlanned: lines.reduce((a, l) => a + l.plannedCases, 0),
    orders: [...orders.values()],
    breakMin: brk ? { startMin: brk.startMin, endMin: brk.endMin } : null,
  };
}

/**
 * The planned stop of (load, sequence) on the live plan. The load row was already checked to be this
 * company's (truckDayLoads); its RouteAssignment rows are reached through it. Null = STOP_NOT_FOUND.
 */
export async function plannedStopOf(tx: Db, load: { id: string; breakJson?: unknown }, sequence: number): Promise<PlannedStop | null> {
  const rows = await tx.routeAssignment.findMany({
    where: { loadId: load.id, sequenceInTruck: sequence },
    orderBy: [{ orderInStop: 'asc' }],
    select: {
      orderId: true,
      orderInStop: true,
      etaMin: true,
      serviceStartMin: true,
      departureMin: true,
      portionLinesJson: true,
      stopSnapshotJson: true,
      order: {
        select: {
          id: true,
          customerId: true,
          carriedToOrderId: true,
          customer: { select: { code: true, name: true, lat: true, lng: true } },
          lines: { select: { id: true, cases: true, weightKg: true, product: { select: { code: true } } } },
        },
      },
    },
  });
  return plannedStopFromRows(rows as unknown as AssignmentRow[], load.breakJson ?? null);
}

/** The stop sequences of a load (every stop must have a result before the driver can close it). */
export async function loadSequences(tx: Db, loadId: string): Promise<number[]> {
  const rows = await tx.routeAssignment.findMany({ where: { loadId }, select: { sequenceInTruck: true } });
  return [...new Set(rows.map((r) => r.sequenceInTruck))].sort((a, b) => a - b);
}
