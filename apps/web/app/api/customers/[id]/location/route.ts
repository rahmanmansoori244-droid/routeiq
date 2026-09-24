import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail, notFoundIfNull } from '@/lib/api';
import { audit } from '@/lib/audit';
import { resolveLocationInput } from '@/lib/dispatch/location-input';
import { coordStatus, parseServiceArea } from '@/lib/dispatch/customer-attrs';

interface Params { params: { id: string } }

const schema = z.object({
  input: z.string().max(2000).optional(), // Google Maps link / "lat, lng" as pasted
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  source: z.enum(['GOOGLE_MAPS_URL', 'MANUAL_LATLNG', 'MAP_PIN', 'GEOCODER']).optional(),
  confirmOutsideArea: z.boolean().optional(),
});

// PUT /api/customers/:id/location - save a dispatcher-confirmed location PERMANENTLY on the
// customer master (tomorrow RouteIQ already knows this customer).
//  - { lat, lng, source } from a map pin or a confirmed preview, or
//  - { input } to parse a link / coordinates; if it is not confident (map centre only, low
//    precision, outside Oman/UAE) the API answers 422 with the parse so the UI asks for a pin.
export const PUT = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.customer.findUnique({ where: { id: params.id } }));
      const body = await parseBody(r, schema);
      const cfg = await db.tenantConfig.findUnique({ where: { tenantId: user.tenantId } });
      const area = parseServiceArea(cfg?.serviceAreaJson);
      let lat = body.lat;
      let lng = body.lng;
      let source = body.source;
      if (lat === undefined || lng === undefined) {
        if (!body.input) return fail('Send a location link / coordinates, or lat + lng from the map.', 400);
        const parsed = await resolveLocationInput(body.input, { area });
        if (!parsed.ok || parsed.needsPin) {
          return fail({ code: 'CONFIRM_ON_MAP', message: parsed.error ?? 'Please confirm the point on the map.', parse: parsed } as Record<string, unknown>, 422);
        }
        lat = parsed.lat!;
        lng = parsed.lng!;
        source = parsed.source ?? 'GOOGLE_MAPS_URL';
      }
      const cs = coordStatus(lat, lng, area);
      if (cs === 'INVALID' || cs === 'MISSING') return fail('That is not a valid location.', 400);
      if (cs === 'OUTSIDE_AREA' && !body.confirmOutsideArea) {
        return fail({ code: 'OUTSIDE_AREA', message: 'This point is outside Oman/UAE. Confirm to save it anyway.' } as Record<string, unknown>, 422);
      }
      const after = await db.customer.update({
        where: { id: params.id },
        data: {
          lat,
          lng,
          locationInput: body.input?.slice(0, 2000) ?? (source === 'MAP_PIN' ? 'map pin' : `${lat}, ${lng}`),
          locationSource: source ?? 'MANUAL_LATLNG',
          locationVerified: true,
          locationVerifiedById: user.id,
          locationVerifiedAt: new Date(),
          geocodeConfidence: 'HIGH',
        },
      });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'CUSTOMER_LOCATION_SET',
        entity: 'Customer',
        entityId: after.id,
        beforeJson: { lat: before.lat, lng: before.lng, source: before.locationSource, verified: before.locationVerified } as never,
        afterJson: { lat, lng, source: after.locationSource, input: after.locationInput } as never,
        ip,
      });
      return ok({ id: after.id, lat: after.lat, lng: after.lng, locationSource: after.locationSource, locationVerified: after.locationVerified });
    },
    { role: 'PLANNER' },
  )(req);
