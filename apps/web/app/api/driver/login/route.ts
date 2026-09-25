/** Legacy driver app: PIN login. Retired - always 410 (see lib/driver-app.ts). */
import { driverAppGone } from '@/lib/driver-app';

export const dynamic = 'force-dynamic';

export async function POST() {
  return driverAppGone();
}
