import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail, notFoundIfNull } from '@/lib/api';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';

interface Params { params: { id: string } }

const bodySchema = z.object({ scenarioId: z.string().min(1) });

interface SolverRouteStopJson {
  sequence: number;
  order_id: string;
  customer_id: string;
  planned_arrival_min: number;
  planned_distance_from_prev_km: number;
  planned_load_cases: number;
}
interface SolverRouteJson {
  truck_id: string;
  stops: SolverRouteStopJson[];
}
interface ScenarioDetailsJson {
  routes?: SolverRouteJson[];
}

interface PlannedStop {
  truckId: string;
  orderId: string;
  plannedArrivalMin: number;
  plannedDistanceFromPrevKm: number;
  plannedLoadCases: number;
  lockedByUserId: string | null;
  manualOverrideReason: string | null;
  /** Sort key — locked stops sort by original sequence; new stops sort by scenario sequence + 10000. */
  sortKey: number;
}

export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const input = await parseBody(r, bodySchema);
      const run = notFoundIfNull(await db.runPlan.findUnique({ where: { id: params.id } }));
      if (run.status !== 'READY') return fail(`Run is ${run.status}, not READY.`, 409);

      const scenario = await db.scenarioResult.findUnique({ where: { id: input.scenarioId } });
      if (!scenario || scenario.runId !== run.id) return fail('Scenario not found for this run.', 404);

      const details = scenario.detailsJson as ScenarioDetailsJson;
      const routes = details?.routes ?? [];

      // Pre-flight: capture locked assignments BEFORE delete. If the prior
      // optimize ran with respectLocks=true, the scenario routes already exclude
      // these stops, so they must be merged back in here. Locked stops keep
      // their relative order; new scenario stops fill in after them.
      const lockedExisting = await db.routeAssignment.findMany({
        where: { runId: run.id, lockedByUserId: { not: null } },
      });

      const { assignmentCount, locksPreserved } = await prisma.$transaction(async (tx) => {
        await tx.routeAssignment.deleteMany({ where: { runId: run.id } });

        // Group stops per truck — locked first (origSeq), scenario routes after (10000 + scenario seq).
        const byTruck = new Map<string, PlannedStop[]>();
        for (const l of lockedExisting) {
          const list = byTruck.get(l.truckId) ?? [];
          list.push({
            truckId: l.truckId,
            orderId: l.orderId,
            plannedArrivalMin: l.plannedArrivalMin,
            plannedDistanceFromPrevKm: l.plannedDistanceFromPrevKm,
            plannedLoadCases: l.plannedLoadCases,
            lockedByUserId: l.lockedByUserId,
            manualOverrideReason: l.manualOverrideReason,
            sortKey: l.sequenceInTruck,
          });
          byTruck.set(l.truckId, list);
        }
        for (const r2 of routes) {
          const list = byTruck.get(r2.truck_id) ?? [];
          for (const s of r2.stops) {
            list.push({
              truckId: r2.truck_id,
              orderId: s.order_id,
              plannedArrivalMin: s.planned_arrival_min,
              plannedDistanceFromPrevKm: s.planned_distance_from_prev_km,
              plannedLoadCases: s.planned_load_cases,
              lockedByUserId: null,
              manualOverrideReason: null,
              sortKey: 10_000 + s.sequence,
            });
          }
          byTruck.set(r2.truck_id, list);
        }

        let n = 0;
        for (const [truckId, list] of byTruck) {
          list.sort((a, b) => a.sortKey - b.sortKey);
          for (let i = 0; i < list.length; i++) {
            const s = list[i];
            await tx.routeAssignment.create({
              data: {
                runId: run.id,
                truckId,
                orderId: s.orderId,
                sequenceInTruck: i + 1,
                plannedArrivalMin: s.plannedArrivalMin,
                plannedDistanceFromPrevKm: s.plannedDistanceFromPrevKm,
                plannedLoadCases: s.plannedLoadCases,
                lockedByUserId: s.lockedByUserId,
                manualOverrideReason: s.manualOverrideReason,
              },
            });
            n++;
          }
        }
        await tx.runPlan.update({
          where: { id: run.id },
          data: { chosenScenarioId: scenario.id, unservedCount: scenario.unservedCount },
        });
        return { assignmentCount: n, locksPreserved: lockedExisting.length };
      });

      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'SCENARIO_CHOSEN',
        entity: 'RunPlan',
        entityId: run.id,
        afterJson: {
          scenarioId: scenario.id,
          name: scenario.name,
          trucksUsed: scenario.trucksUsed,
          totalDistanceKm: scenario.totalDistanceKm,
          assignmentsCreated: assignmentCount,
          locksPreserved,
        } as never,
        ip,
      });

      return ok({ scenarioId: scenario.id, assignmentsCreated: assignmentCount, locksPreserved });
    },
    { role: 'PLANNER' },
  )(req);
