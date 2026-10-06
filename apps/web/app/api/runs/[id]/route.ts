import { withTenantApi, ok, notFoundIfNull } from '@/lib/api';
import { shownTruckCode } from '@/lib/dispatch/hire';

interface Params { params: { id: string } }

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db }) => {
    const run = notFoundIfNull(
      await db.runPlan.findUnique({
        where: { id: params.id },
        include: {
          depot: { select: { id: true, code: true, name: true, lat: true, lng: true } },
          scenarios: {
            orderBy: { createdAt: 'desc' },
            include: {
              unservedOrders: {
                include: {
                  order: {
                    include: { customer: { select: { code: true, name: true, branchKey: true } } },
                  },
                },
              },
            },
          },
          // Job status only: the solver request/response JSON (per-stop revenue, margin,
          // coordinates) is served by the SUPERVISOR-only debug route (review F15).
          jobs: {
            orderBy: { attemptNo: 'desc' },
            select: {
              id: true,
              status: true,
              attemptNo: true,
              progressPct: true,
              message: true,
              createdAt: true,
              startedAt: true,
              finishedAt: true,
            },
          },
          routes: {
            include: {
              truck: { select: { id: true, code: true, capacityCases: true, onlyOnDate: true } },
              order: {
                select: {
                  id: true,
                  totalCases: true,
                  totalWeightKg: true,
                  customer: { select: { id: true, code: true, name: true, branchKey: true, address: true, lat: true, lng: true } },
                },
              },
            },
            orderBy: [{ truckId: 'asc' }, { sequenceInTruck: 'asc' }],
          },
        },
      }),
    );
    // A hired truck whose plate a later day's truck took shows the plate it drove with (hire.ts
    // shownTruckCode); its truck keeps the fields it always had.
    const routes = run.routes.map(({ truck: { onlyOnDate, ...truck }, ...r }) => ({ ...r, truck: { ...truck, code: shownTruckCode(null, { code: truck.code, onlyOnDate }) } }));
    return ok({ ...run, routes });
  })(req);
