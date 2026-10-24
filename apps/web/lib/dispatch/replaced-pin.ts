/**
 * A stop still planned at a point that was not usable when a new pin replaced it (A5 third review):
 * LOCK, LOADING and DISPATCH refuse its load with 409 STOP_PIN_REPLACED (locationGate in
 * plan-service.ts), and the kept-load warning (kept-changes-server.ts) says so on the load. Its own
 * module so both read the same answer: kept-changes-server cannot import plan-service (plan-service
 * imports it). Reads only the customers' recorded location changes (CUSTOMER_LOCATION_SET).
 */
import type { Prisma } from '@prisma/client';
import type { prisma } from '../db';
import { locationBlocksDelivery } from './customer-attrs';
import type { ServiceArea } from './location-input';
import { distanceM, PIN_MOVED_M, readStopSnapshot } from './snapshots';

/** The client the caller reads with: the app's, or a transaction's (the status change's, the kept-load report's). */
type Db = Prisma.TransactionClient | typeof prisma;

/** A customer's point as a location change recorded it before the change (CUSTOMER_LOCATION_SET beforeJson). */
function replacedPoint(json: unknown): { lat: number; lng: number; locationVerified: boolean; geocodeConfidence: string | null } | null {
  if (!json || typeof json !== 'object') return null;
  const b = json as Record<string, unknown>;
  if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return null;
  return { lat: b.lat, lng: b.lng, locationVerified: b.verified === true, geocodeConfidence: typeof b.confidence === 'string' ? b.confidence : null };
}

/** The point a location change set (CUSTOMER_LOCATION_SET afterJson), or null when the row does not say. */
function setPoint(json: unknown): { lat: number; lng: number } | null {
  if (!json || typeof json !== 'object') return null;
  const a = json as Record<string, unknown>;
  return typeof a.lat === 'number' && typeof a.lng === 'number' ? { lat: a.lat, lng: a.lng } : null;
}

/**
 * The customers of `stops` whose stop is still planned at a point that was NOT usable when a new
 * pin replaced it (A5 third review): the stop's planned pin (stopSnapshotJson) is more than
 * PIN_MOVED_M from the customer's point now, and the recorded location change (CUSTOMER_LOCATION_SET:
 * a pin or reading saved in ADD LOCATION or Set location, or a customer import that wrote a new pair
 * over it) that last moved the customer off exactly that point did so while the point blocked
 * delivery (`locationBlocksDelivery`: LOW or outside the area and never confirmed, 0,0). The stop, its
 * links and the driver's texts still go to the planned point until a re-plan. An ordinary correction
 * of a usable point is not refused: the sheets show the planned stop with the new pin noted (frozen
 * plan facts, owner default, F08).
 * A5 fourth review: only the change that replaced the planned point counts. A change that confirmed
 * the point where it was moves nothing, and of the changes off the point only the newest is the one
 * that replaced it (an older one was undone when the customer came back to it). Before, any recorded
 * "before" at the planned point while it was flagged refused the load, so an ordinary correction of a
 * point confirmed where it was got "its old point, which was not usable" and a locked load was sent
 * through unlock and RE-PLAN. Changes made in the same millisecond count as the newest together
 * (refused when one of them blocked). A move off a usable point by a customer import writes no row;
 * the newest recorded change then stands for it, which can only refuse more, never less.
 * A5 fifth review: "the planned point" is its place, PIN_MOVED_M around it - the distance at which
 * this gate (above) and the sheets' "New pin" note count a pin as the same place. A change counts
 * when it started there and moved the customer out of it; one that ended there too (a flagged point
 * confirmed where it is: its coordinates typed, or a hand pin a few metres off, which is the only way
 * a pin can confirm it - a pin exactly on a flagged saved point is refused, PIN_REQUIRED) moved
 * nothing. Before, a change had to start exactly at the planned point (within 5 cm): the correction
 * of such a pin was never counted, so the older flagged row refused an ordinary correction.
 */
export async function stopsAtReplacedPoints(
  tx: Db,
  tenantId: string,
  stops: { customerId: string; stopSnapshotJson: unknown }[],
  customers: Map<string, { lat: number | null; lng: number | null }>,
  area: ServiceArea,
): Promise<Set<string>> {
  const moved = new Map<string, { lat: number; lng: number }[]>();
  for (const s of stops) {
    const snap = readStopSnapshot(s.stopSnapshotJson);
    const now = customers.get(s.customerId);
    if (!snap || snap.lat === null || snap.lng === null || !now || now.lat === null || now.lng === null) continue;
    const planned = { lat: snap.lat, lng: snap.lng };
    if (distanceM(planned, { lat: now.lat, lng: now.lng }) <= PIN_MOVED_M) continue;
    moved.set(s.customerId, [...(moved.get(s.customerId) ?? []), planned]);
  }
  const out = new Set<string>();
  if (!moved.size) return out;
  const changes = await tx.auditLog.findMany({
    where: { tenantId, entity: 'Customer', action: 'CUSTOMER_LOCATION_SET', entityId: { in: [...moved.keys()] } },
    select: { entityId: true, beforeJson: true, afterJson: true, createdAt: true },
  });
  // Per customer and planned point: the newest change that moved the customer out of that point's
  // place, and whether it (or one made in the same millisecond) did so while the point it started
  // from blocked delivery.
  const newest = new Map<string, { at: number; blocked: boolean }>();
  for (const ch of changes) {
    const before = replacedPoint(ch.beforeJson);
    const planned = ch.entityId ? moved.get(ch.entityId) : undefined;
    if (!before || !planned) continue;
    const after = setPoint(ch.afterJson);
    const at = ch.createdAt.getTime();
    const blocked = locationBlocksDelivery(before, area);
    planned.forEach((p, i) => {
      if (distanceM(p, before) > PIN_MOVED_M) return; // started elsewhere
      if (after && distanceM(p, after) <= PIN_MOVED_M) return; // ended there too: nothing moved out
      const key = `${ch.entityId}\u0000${i}`;
      const seen = newest.get(key);
      if (!seen || at > seen.at) newest.set(key, { at, blocked });
      else if (at === seen.at && blocked) seen.blocked = true;
    });
  }
  for (const [key, { blocked }] of newest) if (blocked) out.add(key.slice(0, key.indexOf('\u0000')));
  return out;
}
