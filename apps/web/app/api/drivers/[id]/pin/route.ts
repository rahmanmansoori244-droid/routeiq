/**
 * Legacy driver app: set or rotate a driver's PIN. Retired - always 410 (see lib/driver-app.ts).
 * The Drivers screen no longer offers it; driver name, phone and active status are unchanged.
 */
import { driverAppGone } from '@/lib/driver-app';

export const dynamic = 'force-dynamic';

export async function POST() {
  return driverAppGone();
}
