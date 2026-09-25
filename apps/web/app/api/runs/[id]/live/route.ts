/**
 * Legacy driver app: live truck positions for a run (fed by driver-app GPS pings).
 * Retired - always 410 (see lib/driver-app.ts).
 */
import { driverAppGone } from '@/lib/driver-app';

export const dynamic = 'force-dynamic';

export async function GET() {
  return driverAppGone();
}
