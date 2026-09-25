/**
 * The legacy driver phone app ("Module C": /driver PWA, PIN login, GPS pings, proof of delivery,
 * live tracking) is RETIRED (owner decision, Sep 2026). NMWC never used it; it could not work
 * with more than one truck, and it carried open review findings (F12, F14, driver PIN).
 *
 * Its API routes answer 410 Gone before any authentication or database work, so no row is ever
 * written. The data (DriverShift, TruckLocation, DeliveryProof) is kept until the owner confirms
 * it can be dropped. Driver sheets (PDF), WhatsApp messages and the driver per load are NOT part
 * of this app and keep working.
 */
import { NextResponse } from 'next/server';

export const DRIVER_APP_RETIRED_MESSAGE =
  'The RouteIQ driver app is retired. Use the driver sheet or WhatsApp message from your dispatcher.';

export function driverAppGone(): NextResponse {
  return NextResponse.json(
    { data: null, error: DRIVER_APP_RETIRED_MESSAGE },
    { status: 410, headers: { 'Cache-Control': 'no-store' } },
  );
}
