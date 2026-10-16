/**
 * IVMS live link (16 Oct 2026): the idempotency key of a depot or zone move (IvmsEvent.dedupeKey, unique
 * per company). Ayun delivers a webhook at most once and without an id, and the OBJECT_GET_LAST_EVENTS
 * backstop reports the same event again: both give the same key, so the same move is one row whatever
 * channel brought it first and however often it comes back.
 *
 * The key is built from what the event IS (tracker, type, the fix's time to the second after the channel's
 * time offset, the zone), never from when or how it reached RouteIQ. With the offsets right, a webhook
 * and a backstop row of the same event carry the same instant even when the two channels use different
 * time zones (critique M9). Only a hash is stored: the IMEI is not readable from it.
 */
import { createHash } from 'node:crypto';
import { zoneKey, type ParsedZoneEvent } from './parse';

/** 'ayun:' + 32 hex characters (the database CHECK allows 8-64). */
export function zoneEventDedupeKey(e: Pick<ParsedZoneEvent, 'imei' | 'type' | 'eventAt' | 'zoneName'>): string {
  const second = Math.floor(e.eventAt.getTime() / 1000);
  const text = `${e.imei}|${e.type}|${second}|${zoneKey(e.zoneName) ?? ''}`;
  return `ayun:${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
}
