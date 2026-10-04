import { consumeMore, driverFail, driverOk, readBodyLimited, withDriverLink } from '@/lib/driver-link/guard';
import { actionsBodySchema, recordDriverActions } from '@/lib/delivery/event-service';
import { LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A batch of at most 50 actions is far below this. */
const MAX_BODY_BYTES = 64 * 1024;

// POST /api/d/actions - the driver page's arrivals, departures, results and Back at depot (owner
// request 4 Oct 2026, spec section 8). The token comes in `Authorization: DriverLink <token>`, never in
// the path. Each action carries a lowercase UUID key made on the phone, so a retry never records twice.
// Answers one result per action plus the truck-day's results; 409 PLAN_BUSY when a lock timed out
// (the phone retries). Accepted in the 72 h upload grace for actions dated before the link expired.
// The body is read through a byte-counting reader (413 past 64 KB, with or without Content-Length);
// the per-link limit counts ACTIONS (120 a minute), and at most 2 requests of a link run at once.
export const POST = withDriverLink(
  async (req, ctx) => {
    const text = await readBodyLimited(req, MAX_BODY_BYTES);
    if (text === null) return driverFail({ code: 'TOO_LARGE', message: 'Too many actions in one request.' }, 413);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return driverFail({ code: 'BAD_BODY', message: 'The request could not be read.' }, 400);
    }
    const body = actionsBodySchema.parse(raw);
    // The guard counted the request once; each further action counts too.
    const more = consumeMore(ctx, 'actions', body.actions.length - 1);
    if (!more.ok) return more.response;
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
  { limit: 'actions', write: true, allowUploadOnly: true, maxInFlight: LIMITS.driverInFlight },
);
