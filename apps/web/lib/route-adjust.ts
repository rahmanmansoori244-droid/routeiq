/**
 * Manual route adjustment business logic — CLAUDE.md §11 manual adjustment.
 *
 * Every move/unassign/insert must:
 *   1. Validate capacity + shift time on the receiving truck
 *   2. Resequence the affected truck(s) from 1..N transactionally
 *      (the @@unique([runId, truckId, sequenceInTruck]) constraint won't tolerate gaps)
 *   3. Write AuditLog action=ROUTE_MANUALLY_CHANGED with before/after snapshots
 */
import { Prisma } from '@prisma/client';
import { audit } from './audit';

export type InsertionMode = 'after' | 'end' | 'auto';

export interface MoveInput {
  assignmentId: string;
  targetTruckId: string;
  insertionMode: InsertionMode;
  /** Required when insertionMode === 'after' — id of the assignment to insert after */
  insertAfterAssignmentId?: string | null;
}

export interface RunContext {
  runId: string;
  tenantId: string;
  userId: string;
  ip: string | null;
}

interface AssignmentRow {
  id: string;
  truckId: string;
  orderId: string;
  sequenceInTruck: number;
  plannedArrivalMin: number;
  plannedDistanceFromPrevKm: number;
  plannedLoadCases: number;
  lockedByUserId: string | null;
  manualOverrideReason: string | null;
  order: {
    id: string;
    totalCases: number;
    totalServiceTimeMin: number;
    customer: { id: string; code: string; name: string; branchKey: string; lat: number | null; lng: number | null };
  };
}

interface TruckCap {
  id: string;
  code: string;
  capacityCases: number;
}

interface DepotCoords {
  lat: number;
  lng: number;
}

const EARTH_KM = 6371.0088;
function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dl = ((b.lat - a.lat) * Math.PI) / 180;
  const dg = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dg / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

interface RecomputeArgs {
  rows: AssignmentRow[];
  depot: DepotCoords;
  avgSpeedKmh: number;
  distanceMultiplier: number;
}

/** Recompute planned arrival/distance/load for each row in order. */
function recomputeRoute({ rows, depot, avgSpeedKmh, distanceMultiplier }: RecomputeArgs): AssignmentRow[] {
  let prev = depot;
  let arrivalMin = 0;
  let load = 0;
  const out: AssignmentRow[] = [];
  rows.forEach((r, idx) => {
    const cust = r.order.customer;
    if (cust.lat === null || cust.lng === null) {
      // Skip geometry math if coords missing; keep prior values but resequence.
      out.push({ ...r, sequenceInTruck: idx + 1 });
      return;
    }
    const km = haversine(prev, { lat: cust.lat, lng: cust.lng }) * distanceMultiplier;
    const travelMin = (km / Math.max(avgSpeedKmh, 1)) * 60;
    arrivalMin += travelMin;
    load += r.order.totalCases;
    out.push({
      ...r,
      sequenceInTruck: idx + 1,
      plannedDistanceFromPrevKm: Math.round(km * 1000) / 1000,
      plannedArrivalMin: Math.round(arrivalMin),
      plannedLoadCases: load,
    });
    arrivalMin += r.order.totalServiceTimeMin;
    prev = { lat: cust.lat, lng: cust.lng };
  });
  return out;
}

/**
 * Move an assignment to a different truck. Or, if `targetTruckId === source.truckId`,
 * just resequence within the same truck.
 */
export async function moveAssignment(
  tx: Prisma.TransactionClient,
  ctx: RunContext,
  input: MoveInput,
) {
  const assignment = await tx.routeAssignment.findUnique({
    where: { id: input.assignmentId },
    include: {
      order: {
        include: {
          customer: { select: { id: true, code: true, name: true, branchKey: true, lat: true, lng: true } },
        },
      },
    },
  });
  if (!assignment || assignment.runId !== ctx.runId) {
    throw new RouteAdjustError('Assignment not found in this run.', 404);
  }
  if (assignment.lockedByUserId) {
    throw new RouteAdjustError('Assignment is locked. Unlock before moving.', 409);
  }

  const run = await tx.runPlan.findUnique({
    where: { id: ctx.runId },
    include: { depot: true },
  });
  if (!run) throw new RouteAdjustError('Run not found.', 404);
  if (run.status === 'DISPATCHED' || run.status === 'ARCHIVED') {
    throw new RouteAdjustError(`Cannot edit a ${run.status} run. Unlock the run first.`, 409);
  }

  const config = await tx.tenantConfig.findUniqueOrThrow({ where: { tenantId: ctx.tenantId } });
  const depot: DepotCoords = { lat: run.depot.lat, lng: run.depot.lng };

  // Target truck must belong to the same tenant + depot.
  const targetTruck = await tx.truck.findUnique({
    where: { id: input.targetTruckId },
    select: { id: true, code: true, capacityCases: true, depotId: true, active: true, tenantId: true },
  });
  if (!targetTruck || targetTruck.tenantId !== ctx.tenantId || targetTruck.depotId !== run.depotId) {
    throw new RouteAdjustError('Target truck not valid for this run.', 400);
  }
  if (!targetTruck.active) throw new RouteAdjustError('Target truck is inactive.', 400);

  // Pull all current assignments on source + target trucks.
  const sourceTruckId = assignment.truckId;
  const isSameTruck = sourceTruckId === targetTruck.id;

  const sourceList = await tx.routeAssignment.findMany({
    where: { runId: ctx.runId, truckId: sourceTruckId },
    orderBy: { sequenceInTruck: 'asc' },
    include: {
      order: {
        include: {
          customer: { select: { id: true, code: true, name: true, branchKey: true, lat: true, lng: true } },
        },
      },
    },
  });
  const targetList = isSameTruck
    ? sourceList
    : await tx.routeAssignment.findMany({
        where: { runId: ctx.runId, truckId: targetTruck.id },
        orderBy: { sequenceInTruck: 'asc' },
        include: {
          order: {
            include: {
              customer: { select: { id: true, code: true, name: true, branchKey: true, lat: true, lng: true } },
            },
          },
        },
      });

  // Remove the moving assignment from source.
  const newSource: AssignmentRow[] = sourceList.filter((a) => a.id !== assignment.id) as AssignmentRow[];

  // Build target list with insertion.
  const movingRow = sourceList.find((a) => a.id === assignment.id) as AssignmentRow;
  const targetWithoutMoving: AssignmentRow[] = (isSameTruck ? newSource : (targetList as AssignmentRow[])).slice();

  let newTarget: AssignmentRow[];
  switch (input.insertionMode) {
    case 'end':
      newTarget = [...targetWithoutMoving, movingRow];
      break;
    case 'after': {
      const anchorIdx = input.insertAfterAssignmentId
        ? targetWithoutMoving.findIndex((a) => a.id === input.insertAfterAssignmentId)
        : -1;
      if (anchorIdx < 0) {
        newTarget = [...targetWithoutMoving, movingRow]; // fallback: append
      } else {
        newTarget = [
          ...targetWithoutMoving.slice(0, anchorIdx + 1),
          movingRow,
          ...targetWithoutMoving.slice(anchorIdx + 1),
        ];
      }
      break;
    }
    case 'auto':
    default: {
      // Place at the position that minimizes distance increase given current geometry.
      // For v1 we use a simple nearest-anchor: insert next to the stop closest to the moving customer.
      const mc = movingRow.order.customer;
      if (mc.lat === null || mc.lng === null || targetWithoutMoving.length === 0) {
        newTarget = [...targetWithoutMoving, movingRow];
        break;
      }
      let bestIdx = targetWithoutMoving.length;
      let bestKm = Infinity;
      for (let i = 0; i < targetWithoutMoving.length; i++) {
        const c = targetWithoutMoving[i].order.customer;
        if (c.lat === null || c.lng === null) continue;
        const km = haversine({ lat: mc.lat, lng: mc.lng }, { lat: c.lat, lng: c.lng });
        if (km < bestKm) {
          bestKm = km;
          bestIdx = i + 1; // insert after closest
        }
      }
      newTarget = [
        ...targetWithoutMoving.slice(0, bestIdx),
        movingRow,
        ...targetWithoutMoving.slice(bestIdx),
      ];
      break;
    }
  }

  // Capacity check on target.
  const targetCases = newTarget.reduce((a, r) => a + r.order.totalCases, 0);
  if (targetCases > targetTruck.capacityCases) {
    throw new RouteAdjustError(
      `Truck ${targetTruck.code} would carry ${targetCases} cases > capacity ${targetTruck.capacityCases}.`,
      400,
    );
  }

  // Shift time check on target (sum of recomputed arrival + service of last stop).
  const recomputedTarget = recomputeRoute({
    rows: newTarget,
    depot,
    avgSpeedKmh: config.avgSpeedKmh,
    distanceMultiplier: config.distanceMultiplier,
  });
  const lastTarget = recomputedTarget[recomputedTarget.length - 1];
  const targetEndMin = lastTarget
    ? lastTarget.plannedArrivalMin + (lastTarget.order.totalServiceTimeMin ?? 0)
    : 0;
  if (targetEndMin > config.driverShiftMaxMinutes) {
    throw new RouteAdjustError(
      `Truck ${targetTruck.code} route would run ${Math.round(targetEndMin / 60)}h > shift max ${Math.round(
        config.driverShiftMaxMinutes / 60,
      )}h.`,
      400,
    );
  }

  // Recompute source after removal.
  const recomputedSource = recomputeRoute({
    rows: newSource,
    depot,
    avgSpeedKmh: config.avgSpeedKmh,
    distanceMultiplier: config.distanceMultiplier,
  });

  // Snapshot before/after for audit (just the moving stop + truck codes is enough).
  const before = {
    truckId: sourceTruckId,
    sequence: assignment.sequenceInTruck,
  };
  const after = {
    truckId: targetTruck.id,
    truckCode: targetTruck.code,
    insertionMode: input.insertionMode,
    newSequence: recomputedTarget.findIndex((r) => r.id === assignment.id) + 1,
  };

  // Apply updates. To avoid violating the @@unique([runId, truckId, sequenceInTruck])
  // constraint mid-flight, we first stamp DISTINCT negative sequences per row
  // (so the unique constraint stays satisfied during the in-flight shuffle),
  // then re-stamp the final positive values.
  await parkSequencesNegative(
    tx,
    ctx.runId,
    isSameTruck ? [targetTruck.id] : [sourceTruckId, targetTruck.id],
  );

  // Now re-stamp via a small CTE — Prisma doesn't support multi-row UPDATE with different
  // values per row easily, so loop. The tx is short-lived; the row count is small.
  for (const r of recomputedSource) {
    await tx.routeAssignment.update({
      where: { id: r.id },
      data: {
        truckId: sourceTruckId,
        sequenceInTruck: r.sequenceInTruck,
        plannedArrivalMin: r.plannedArrivalMin,
        plannedDistanceFromPrevKm: r.plannedDistanceFromPrevKm,
        plannedLoadCases: r.plannedLoadCases,
      },
    });
  }
  for (const r of recomputedTarget) {
    await tx.routeAssignment.update({
      where: { id: r.id },
      data: {
        truckId: targetTruck.id,
        sequenceInTruck: r.sequenceInTruck,
        plannedArrivalMin: r.plannedArrivalMin,
        plannedDistanceFromPrevKm: r.plannedDistanceFromPrevKm,
        plannedLoadCases: r.plannedLoadCases,
      },
    });
  }

  await audit(
    {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: 'ROUTE_MANUALLY_CHANGED',
      entity: 'RouteAssignment',
      entityId: assignment.id,
      beforeJson: before as never,
      afterJson: after as never,
      ip: ctx.ip,
    },
    tx,
  );

  return {
    movedAssignmentId: assignment.id,
    newTruckId: targetTruck.id,
    newSequence: after.newSequence,
    resequencedTrucks: isSameTruck ? [targetTruck.id] : [sourceTruckId, targetTruck.id],
  };
}

export async function lockAssignment(
  tx: Prisma.TransactionClient,
  ctx: RunContext,
  assignmentId: string,
  reason: string | null,
) {
  const before = await tx.routeAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, runId: true, lockedByUserId: true, truckId: true, sequenceInTruck: true },
  });
  if (!before || before.runId !== ctx.runId) throw new RouteAdjustError('Assignment not found.', 404);

  const after = await tx.routeAssignment.update({
    where: { id: assignmentId },
    data: { lockedByUserId: ctx.userId, manualOverrideReason: reason },
  });
  await audit(
    {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: 'ROUTE_MANUALLY_CHANGED',
      entity: 'RouteAssignment',
      entityId: assignmentId,
      beforeJson: { locked: false } as never,
      afterJson: { locked: true, reason } as never,
      ip: ctx.ip,
    },
    tx,
  );
  return after;
}

export async function unlockAssignment(
  tx: Prisma.TransactionClient,
  ctx: RunContext,
  assignmentId: string,
) {
  const before = await tx.routeAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, runId: true, lockedByUserId: true },
  });
  if (!before || before.runId !== ctx.runId) throw new RouteAdjustError('Assignment not found.', 404);

  const after = await tx.routeAssignment.update({
    where: { id: assignmentId },
    data: { lockedByUserId: null, manualOverrideReason: null },
  });
  await audit(
    {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: 'ROUTE_MANUALLY_CHANGED',
      entity: 'RouteAssignment',
      entityId: assignmentId,
      beforeJson: { locked: true } as never,
      afterJson: { locked: false } as never,
      ip: ctx.ip,
    },
    tx,
  );
  return after;
}

/** Unassign = delete the assignment row; resequence the remaining stops on that truck. */
export async function unassignAssignment(
  tx: Prisma.TransactionClient,
  ctx: RunContext,
  assignmentId: string,
) {
  const a = await tx.routeAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, runId: true, truckId: true, sequenceInTruck: true, orderId: true },
  });
  if (!a || a.runId !== ctx.runId) throw new RouteAdjustError('Assignment not found.', 404);

  const run = await tx.runPlan.findUnique({
    where: { id: ctx.runId },
    include: { depot: true },
  });
  if (!run) throw new RouteAdjustError('Run not found.', 404);
  const config = await tx.tenantConfig.findUniqueOrThrow({ where: { tenantId: ctx.tenantId } });

  await tx.routeAssignment.delete({ where: { id: assignmentId } });

  const remaining = (await tx.routeAssignment.findMany({
    where: { runId: ctx.runId, truckId: a.truckId },
    orderBy: { sequenceInTruck: 'asc' },
    include: {
      order: {
        include: {
          customer: { select: { id: true, code: true, name: true, branchKey: true, lat: true, lng: true } },
        },
      },
    },
  })) as AssignmentRow[];

  const depot: DepotCoords = { lat: run.depot.lat, lng: run.depot.lng };
  const recomputed = recomputeRoute({
    rows: remaining,
    depot,
    avgSpeedKmh: config.avgSpeedKmh,
    distanceMultiplier: config.distanceMultiplier,
  });
  // Park existing rows out of the unique range, then restamp. Each row gets a
  // distinct negative sequence so the unique constraint stays satisfied.
  await parkSequencesNegative(tx, ctx.runId, [a.truckId]);
  for (const r of recomputed) {
    await tx.routeAssignment.update({
      where: { id: r.id },
      data: {
        sequenceInTruck: r.sequenceInTruck,
        plannedArrivalMin: r.plannedArrivalMin,
        plannedDistanceFromPrevKm: r.plannedDistanceFromPrevKm,
        plannedLoadCases: r.plannedLoadCases,
      },
    });
  }

  await audit(
    {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: 'ROUTE_MANUALLY_CHANGED',
      entity: 'RouteAssignment',
      entityId: assignmentId,
      beforeJson: { truckId: a.truckId, sequence: a.sequenceInTruck, orderId: a.orderId } as never,
      afterJson: { unassigned: true } as never,
      ip: ctx.ip,
    },
    tx,
  );

  return { unassignedAssignmentId: assignmentId, resequencedTrucks: [a.truckId] };
}

export class RouteAdjustError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Park every row on the given trucks at a distinct negative sequence so the
 * @@unique([runId, truckId, sequenceInTruck]) constraint stays satisfied
 * during the in-flight resequencing. Using raw SQL with row_number() is the
 * cleanest way to ensure uniqueness without N round-trips.
 */
async function parkSequencesNegative(
  tx: Prisma.TransactionClient,
  runId: string,
  truckIds: string[],
): Promise<void> {
  if (truckIds.length === 0) return;
  await tx.$executeRaw`
    UPDATE "RouteAssignment" AS ra
    SET "sequenceInTruck" = -sub.rn
    FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY "truckId" ORDER BY id) AS rn
      FROM "RouteAssignment"
      WHERE "runId" = ${runId} AND "truckId" = ANY(${truckIds})
    ) AS sub
    WHERE ra.id = sub.id
  `;
}
