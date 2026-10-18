import { withTenantApi, ok, fail } from '@/lib/api';
import { isIsoDate, TRUCK_DAY_RATE } from '@/lib/ivms/truck-day';
import { readTruckDay } from '@/lib/ivms/truck-day-read';

export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// GET /api/ivms/trucks/:id/day?date=YYYY-MM-DD - one truck's day (owner request 18 Oct 2026: "i click on
// [a truck] it takes me to where the truck is and what it was doing"): its loads on the plans in use of the
// date, the timeline (dispatch, depot out and in, each stop with its plan, its times and who recorded
// them, the results, earlier GPS visits, the alerts), the stops for the map, the GPS trail (TIMES) and
// the live position (MAP and up, today). PLANNER and up, like the day screen's live trucks (positions
// of people at work; VIEWER 403), 30 a minute per user. No date: the company's today; a date that is
// not YYYY-MM-DD: 400. Another company's truck (or no such truck): 404. Reads only; never an IMEI, an
// Ayun object or zone name, or any other provider field (lib/ivms/truck-day-read.ts).
export const GET = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user }) => {
      const date = new URL(r.url).searchParams.get('date');
      if (date !== null && !isIsoDate(date)) return fail({ code: 'BAD_DATE', message: 'date must be a calendar date written YYYY-MM-DD' }, 400);
      const data = await readTruckDay(user.tenantId, params.id, date);
      if (!data) return fail('Not found', 404);
      return ok(data);
    },
    { role: 'PLANNER', rateLimitKey: 'ivms-truck-day', rateLimitLimit: TRUCK_DAY_RATE.limit, rateLimitWindowMs: TRUCK_DAY_RATE.windowMs },
  )(req);
