/** Legacy driver app: the truck's stop list. Retired - always 410 (see lib/driver-app.ts). */
import { driverAppGone } from '@/lib/driver-app';

export const dynamic = 'force-dynamic';

export async function GET() {
  return driverAppGone();
}
