import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail, notFoundIfNull } from '@/lib/api';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import {
  checkManualLocation,
  pinRequiredMessage,
  rereadSavedInput,
  resolveLocationInput,
  samePoint,
  PIN_REQUIRED_MESSAGE,
  type Confidence,
} from '@/lib/dispatch/location-input';
import { coordStatus, savedPointProblem } from '@/lib/dispatch/customer-attrs';
import { tenantServiceArea } from '@/lib/dispatch/service-area';

interface Params { params: { id: string } }

const schema = z.object({
  input: z.string().max(2000).optional(), // Google Maps link / "lat, lng" as pasted
  // The final Google Maps address a short link led to when it was Read (POST /api/locations/parse):
  // read again here without any network call (audit PR A5).
  resolvedUrl: z.string().max(4000).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  // No GEOCODER: nothing geocodes, and a client cannot choose the source it is stored with.
  source: z.enum(['GOOGLE_MAPS_URL', 'MANUAL_LATLNG', 'MAP_PIN']).optional(),
  confirmOutsideArea: z.boolean().optional(),
});

const pinRequired = (message: string, parse?: unknown) => fail({ code: 'PIN_REQUIRED', message, ...(parse ? { parse } : {}) } as Record<string, unknown>, 422);

// PUT /api/customers/:id/location - save a dispatcher-confirmed location PERMANENTLY on the
// customer master (tomorrow RouteIQ already knows this customer).
//
// The owner's rule (27 Sep 2026, audit PR A5): a location is always correct; a reading that is not
// exact is never saved as read. This route enforces it itself, whatever the screen sends:
//  - { lat, lng, source: 'MAP_PIN' }: a pin placed by hand, stored HIGH. The customer's own saved
//    point sent back unchanged is not a hand pin: it is confirmed as it is only when it is already
//    verified, or HIGH and inside the company's delivery area (savedPointProblem, the dialog's test);
//    else 422 PIN_REQUIRED with the reason (not exact, outside the area, swapped). A "hand pin"
//    exactly on the point its text reads as, when that reading needs a pin, was not moved: 422
//    PIN_REQUIRED.
//  - { lat, lng, input, resolvedUrl? } from a Read: the input is read again (no network; a short link
//    through the resolvedUrl the Read returned). 422 PIN_REQUIRED when the reading needs a pin or
//    cannot be read, 422 LOCATION_MISMATCH when the point sent is not the point it reads as.
//  - { input } alone: read (short links resolved, as the Read does); 422 PIN_REQUIRED unless exact.
// A point outside the service area is 422 OUTSIDE_AREA until the dispatcher confirms it (only a
// hand pin can get there: a reading outside the area always needs a pin).
export const PUT = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.customer.findUnique({ where: { id: params.id } }));
      const body = await parseBody(r, schema);
      const area = await tenantServiceArea(user.tenantId);
      let lat: number;
      let lng: number;
      let source: string;
      let confidence: Confidence | string = 'HIGH';
      let input: string | null = body.input?.trim() ? body.input.slice(0, 2000) : null;
      let check: 'HAND_PIN' | 'READING' | 'SAVED_POINT';
      if (body.lat === undefined || body.lng === undefined) {
        if (!body.input) return fail('Send a location link / coordinates, or lat + lng from the map.', 400);
        const parsed = await resolveLocationInput(body.input, { area });
        if (!parsed.ok || parsed.needsPin) return pinRequired(pinRequiredMessage(parsed), parsed);
        lat = parsed.lat!;
        lng = parsed.lng!;
        source = parsed.source ?? 'GOOGLE_MAPS_URL';
        confidence = parsed.confidence ?? 'HIGH';
        check = 'READING';
      } else if (body.source === 'MAP_PIN') {
        lat = body.lat;
        lng = body.lng;
        source = 'MAP_PIN';
        check = 'HAND_PIN';
        if (before.lat !== null && before.lng !== null && samePoint({ lat, lng }, { lat: before.lat, lng: before.lng })) {
          // The customer's saved point, sent back as it is (the dialog opens on it): not placed by hand.
          // The dialog's own test (savedPointProblem), with the company's area; the reason is named.
          const problem = savedPointProblem(before, area);
          if (problem) return pinRequired(problem);
          source = before.locationSource ?? 'MAP_PIN';
          confidence = before.locationVerified ? before.geocodeConfidence ?? 'HIGH' : 'HIGH';
          input = before.locationInput;
          check = 'SAVED_POINT';
        } else if (input) {
          // A hand pin exactly on a reading that needs a pin was never moved.
          const p = rereadSavedInput(input, body.resolvedUrl, area);
          if (p.ok && p.needsPin && p.lat !== undefined && p.lng !== undefined && samePoint({ lat, lng }, { lat: p.lat, lng: p.lng })) {
            return pinRequired(PIN_REQUIRED_MESSAGE, p);
          }
        }
      } else {
        const c = checkManualLocation({ input: body.input, resolvedUrl: body.resolvedUrl, lat: body.lat, lng: body.lng, area });
        if (!c.ok) return fail({ code: c.code, message: c.message, ...(c.parse ? { parse: c.parse } : {}) } as Record<string, unknown>, 422);
        lat = c.lat;
        lng = c.lng;
        source = c.source;
        confidence = c.confidence;
        check = 'READING';
      }
      const cs = coordStatus(lat, lng, area);
      if (cs === 'INVALID' || cs === 'MISSING') return fail('That is not a valid location.', 400);
      if (cs === 'OUTSIDE_AREA' && !body.confirmOutsideArea) {
        return fail({ code: 'OUTSIDE_AREA', message: 'This point is outside Oman/UAE. Confirm to save it anyway.' } as Record<string, unknown>, 422);
      }
      // The change and its audit row commit together (A5 third review): LOCK, LOADING and DISPATCH
      // read the row's "before" point to refuse a stop still planned at a point replaced while it
      // was not usable (plan-service locationGate). That point is the customer's as it is when the
      // change is written, the customer locked meanwhile (A5 fifth review: the row said what the
      // route had read at the start, so a point a customer file marked LOW in between was recorded
      // as usable).
      const after = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${params.id} AND "tenantId" = ${user.tenantId} FOR UPDATE`;
        const replaced =
          (await tx.customer.findFirst({
            where: { id: params.id, tenantId: user.tenantId },
            select: { lat: true, lng: true, locationSource: true, locationVerified: true, geocodeConfidence: true },
          })) ?? before;
        const saved = await tx.customer.update({
          where: { id: params.id, tenantId: user.tenantId },
          data: {
            lat,
            lng,
            locationInput: input ?? (source === 'MAP_PIN' ? 'map pin' : `${lat}, ${lng}`),
            locationSource: source as never,
            locationVerified: true,
            locationVerifiedById: user.id,
            locationVerifiedAt: new Date(),
            // Truthful (audit PR A5): a hand pin is HIGH; a reading is the parser's (always HIGH, the
            // parser asks for a pin for every MEDIUM or LOW one); a saved point confirmed keeps its own.
            geocodeConfidence: confidence,
          },
        });
        await audit(
          {
            tenantId: user.tenantId,
            userId: user.id,
            action: 'CUSTOMER_LOCATION_SET',
            entity: 'Customer',
            entityId: saved.id,
            beforeJson: { lat: replaced.lat, lng: replaced.lng, source: replaced.locationSource, verified: replaced.locationVerified, confidence: replaced.geocodeConfidence } as never,
            afterJson: { lat, lng, source: saved.locationSource, input: saved.locationInput, confidence: saved.geocodeConfidence, check } as never,
            ip,
          },
          tx,
        );
        return saved;
      });
      return ok({ id: after.id, lat: after.lat, lng: after.lng, locationSource: after.locationSource, locationVerified: after.locationVerified, geocodeConfidence: after.geocodeConfidence });
    },
    { role: 'PLANNER' },
  )(req);
