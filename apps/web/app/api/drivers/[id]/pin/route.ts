/**
 * Admin endpoint — set or rotate a driver's PIN (Module C).
 *
 * POST /api/drivers/[id]/pin — optional body { pin: string }. Omit to
 * auto-generate a 6-digit code. Cleartext PIN is returned ONCE; only the
 * bcrypt hash is persisted. Visible to SUPERVISOR+.
 */
import { withTenantApi, ok, fail, notFoundIfNull } from '@/lib/api';
import { audit } from '@/lib/audit';
import { generatePin, hashPin } from '@/lib/driver-auth';

interface Params { params: { id: string } }

const PIN_RE = /^\d{4,12}$/;

export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const driver = notFoundIfNull(
        await db.driver.findUnique({
          where: { id: params.id },
          select: { id: true, code: true, name: true, active: true },
        }),
      );

      let pin: string | undefined;
      if (r.headers.get('content-length') && Number(r.headers.get('content-length')) > 0) {
        try {
          const body = (await r.json()) as { pin?: unknown };
          if (typeof body.pin === 'string') {
            if (!PIN_RE.test(body.pin)) return fail('PIN must be 4–12 digits.', 400);
            pin = body.pin;
          }
        } catch {
          return fail('Invalid JSON body.', 400);
        }
      }
      pin = pin ?? generatePin();
      const accessPinHash = await hashPin(pin);
      await db.driver.update({ where: { id: driver.id }, data: { accessPinHash } });

      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entity: 'Driver',
        entityId: driver.id,
        afterJson: { code: driver.code, pinRotated: true },
        ip,
      });

      return ok({ driverCode: driver.code, pin });
    },
    { role: 'SUPERVISOR' },
  )(req);
