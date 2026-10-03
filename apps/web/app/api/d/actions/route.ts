import { driverFail, driverOk, withDriverLink } from '@/lib/driver-link/guard';
import { actionsBodySchema, recordDriverActions } from '@/lib/delivery/event-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A batch of at most 50 actions is far below this. */
const MAX_BODY_BYTES = 64 * 1024;

// POST /api/d/actions - the driver page's arrivals, departures, results and Back at depot (owner
// request 4 Oct 2026, spec section 8). The token comes in `Authorization: DriverLink <token>`, never in
// the path. Each action carries a lowercase UUID key made on the phone, so a retry never records twice.
// Answers one result per action plus the truck-day's results; 409 PLAN_BUSY when a lock timed out
// (the phone retries). Accepted in the 72 h upload grace for actions dated before the link expired.
export const POST = withDriverLink(
  async (req, ctx) => {
    const declared = Number(req.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return driverFail({ code: 'TOO_LARGE', message: 'Too many actions in one request.' }, 413);
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return driverFail({ code: 'TOO_LARGE', message: 'Too many actions in one request.' }, 413);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return driverFail({ code: 'BAD_BODY', message: 'The request could not be read.' }, 400);
    }
    const body = actionsBodySchema.parse(raw);
    const out = await recordDriverActions(
      {
        tenantId: ctx.tenantId,
        truckId: ctx.truckId,
        date: ctx.date,
        link: ctx.link,
        ip: ctx.ip,
        deviceId: ctx.deviceId,
        session: ctx.session,
        now: ctx.now,
      },
      body,
    );
    return driverOk(out);
  },
  { limit: 'actions', write: true, allowUploadOnly: true },
);
