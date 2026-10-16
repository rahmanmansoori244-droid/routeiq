/**
 * IVMS live link (16 Oct 2026): a provider zone event (webhook or backstop) as the IvmsEvent row it
 * becomes. Pure. The webhook route and the poller's backstop both use it, so the same event always gives
 * the same row and the same idempotency key (lib/ivms/dedupe.ts).
 *
 * - DEPOT_IN / DEPOT_OUT: the zone is a depot of the company (Depot.ivmsZoneName, trimmed and compared
 *   without case). Two depots naming the same zone (critique L5): the truck's own depot first.
 * - When the event carries a position more than DEPOT_ZONE_CHECK_M from that depot's pin, it is not
 *   trusted as a depot move: kept as ZONE_IN / ZONE_OUT, outcome NO_DEPOT, already processed.
 * - Any other zone: ZONE_IN / ZONE_OUT, outcome NO_DEPOT, already processed (a fact, never used).
 * Depot moves are left unprocessed (processedAt NULL) for the processing step, which decides what each
 * one means (trip boundaries, H3) and never completes a load from it (H1). A webhook move is never
 * trusted alone (M6): the processing step confirms it against the trail.
 */
import { distanceM } from '../dispatch/snapshots';
import { zoneEventDedupeKey } from './dedupe';
import { zoneKey, type ParsedZoneEvent } from './parse';
import type { IvmsEventKind, IvmsEventOrigin, IvmsEventOutcome } from './types';

/** A depot whose Ayun zone is set. */
export interface DepotZone {
  depotId: string;
  zoneName: string;
  lat: number;
  lng: number;
}

/** A depot event's position must be within this distance of the depot pin (when it has one). */
export const DEPOT_ZONE_CHECK_M = 2000;
/** IvmsEvent rows per truck per UTC day at most (a flood of forged or flapping events, critique M6). */
export const MAX_EVENTS_PER_TRUCK_DAY = 200;

/** A row to insert into IvmsEvent (tenantId added by the store). */
export interface NewZoneEvent {
  truckId: string;
  depotId: string | null;
  kind: IvmsEventKind;
  origin: IvmsEventOrigin;
  eventAt: Date;
  serverAt: Date | null;
  zoneName: string | null;
  lat: number | null;
  lng: number | null;
  dedupeKey: string;
  outcome: IvmsEventOutcome | null;
  processedAt: Date | null;
}

/** The company's depot for a zone name, the truck's own depot first; null when it is no depot's zone. */
export function depotOfZone(zoneName: string | null, truckDepotId: string, depots: readonly DepotZone[]): DepotZone | null {
  const key = zoneKey(zoneName);
  if (!key) return null;
  const matches = depots.filter((d) => zoneKey(d.zoneName) === key).sort((a, b) => a.depotId.localeCompare(b.depotId));
  return matches.find((d) => d.depotId === truckDepotId) ?? matches[0] ?? null;
}

/** The IvmsEvent row of a zone event of a mapped truck. */
export function zoneEventRow(e: ParsedZoneEvent, truck: { truckId: string; depotId: string }, depots: readonly DepotZone[], origin: IvmsEventOrigin, now: Date): NewZoneEvent {
  const depot = depotOfZone(e.zoneName, truck.depotId, depots);
  const nearDepot = !depot || e.lat === null || e.lng === null || distanceM({ lat: e.lat, lng: e.lng }, depot) <= DEPOT_ZONE_CHECK_M;
  const isDepot = !!depot && nearDepot;
  const inbound = e.type === 'zone_in';
  return {
    truckId: truck.truckId,
    depotId: isDepot ? depot.depotId : null,
    kind: isDepot ? (inbound ? 'DEPOT_IN' : 'DEPOT_OUT') : inbound ? 'ZONE_IN' : 'ZONE_OUT',
    origin,
    eventAt: e.eventAt,
    serverAt: e.serverAt,
    zoneName: e.zoneName,
    lat: e.lat,
    lng: e.lng,
    dedupeKey: zoneEventDedupeKey(e),
    outcome: isDepot ? null : 'NO_DEPOT',
    processedAt: isDepot ? null : now,
  };
}
