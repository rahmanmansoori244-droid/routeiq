/**
 * Legacy driver phone app (stop list). Retired in Sep 2026: this page only says so and clears the
 * old sign-in data from the phone. See lib/driver-app.ts.
 */
import { DriverAppRetiredNotice } from '../retired-notice';

export default function DriverManifestRetiredPage() {
  return <DriverAppRetiredNotice />;
}
