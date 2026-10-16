/**
 * The company admin's GPS tracker mapping (IVMS live link, 16 Oct 2026, design section 8.1): set or clear
 * a truck's tracker IMEI, and suggestions from one provider object list call. Server only. Company admin
 * only (the routes). Every query names the company.
 *
 * - The IMEI is the only link between a truck and a tracker (owner decision D-2 recommendation); a plate
 *   only suggests. Never on a one-day hired truck (database CHECK), never on two trucks (unique key).
 * - Changing a tracker removes the truck's live position, so the map never shows the old tracker's
 *   position for it; replacing or clearing one after today's trail was pulled marks today's GPS times of
 *   the truck suppressed (REMAP: the trail may be another truck's, review M8).
 * - The audit row names the truck and the tracker's last 4 digits only ("ends 1234").
 * - Suggestions: one USER_GET_OBJECTS call (the ADMIN class of the allowance), only in ivmsMode MAP or
 *   TIMES (OFF never calls the provider), only for the company the Ayun account belongs to
 *   (AYUN_TENANT_SLUG). Names and plates of the provider's objects never leave this module.
 */
import { prisma } from '../db';
import { audit } from '../audit';
import { dateOnly, DEFAULT_TZ, todayIso } from '../dispatch/time';
import { ivmsApiReady, readIvmsEnv } from './env';
import { imeiTail, normalizeImei, suggestTrackers, trackerRowsOf, type TrackerSuggestion } from './match';
import { ivmsModeAtLeast, ivmsModeOf } from './settings';
import type { AyunErrorKind, AyunResult } from './types';

export type TrackerSetResult =
  | { ok: true; truckId: string; imei: string | null; changed: boolean; suppressedToday: boolean }
  | { ok: false; status: 400 | 404 | 409 | 422; code: 'IMEI_FORMAT' | 'NOT_FOUND' | 'TRACKER_TAKEN' | 'ONE_DAY_TRUCK'; message: string };

const isUnique = (e: unknown) => (e as { code?: unknown } | null)?.code === 'P2002';

/** Set (or clear, `raw` null or '') the tracker IMEI of a truck of the company. */
export async function setTruckTracker(tenantId: string, truckId: string, raw: string | null, actor: { userId: string; ip: string | null }, now: Date = new Date()): Promise<TrackerSetResult> {
  const imei = raw === null || raw.trim() === '' ? null : normalizeImei(raw);
  if (raw !== null && raw.trim() !== '' && !imei) return { ok: false, status: 400, code: 'IMEI_FORMAT', message: 'A tracker IMEI is 10 to 20 digits (spaces and dashes are ignored).' };
  const truck = await prisma.truck.findFirst({ where: { id: truckId, tenantId }, select: { id: true, code: true, onlyOnDate: true, ivmsImei: true } });
  if (!truck) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Truck not found.' };
  if (imei && truck.onlyOnDate) return { ok: false, status: 422, code: 'ONE_DAY_TRUCK', message: 'A truck hired for one day cannot have a GPS tracker: it is retired with its day.' };
  if ((truck.ivmsImei ?? null) === imei) return { ok: true, truckId, imei, changed: false, suppressedToday: false };
  if (imei) {
    const other = await prisma.truck.findFirst({ where: { tenantId, ivmsImei: imei, NOT: { id: truckId } }, select: { code: true } });
    if (other) return { ok: false, status: 409, code: 'TRACKER_TAKEN', message: `This tracker is already on truck ${other.code}. Clear it there first.` };
  }
  try {
    await prisma.truck.update({ where: { id: truckId }, data: { ivmsImei: imei }, select: { id: true } });
  } catch (e) {
    if (isUnique(e)) return { ok: false, status: 409, code: 'TRACKER_TAKEN', message: 'This tracker is already on another truck. Clear it there first.' };
    throw e;
  }
  // The old tracker's position must never show for this truck.
  await prisma.truckPosition.deleteMany({ where: { tenantId, truckId } });
  // A tracker replaced or removed after today's trail was pulled: today's trail may be the old tracker's.
  let suppressedToday = false;
  if (truck.ivmsImei) {
    const cfg = await prisma.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true } });
    const today = todayIso(cfg?.timezone || DEFAULT_TZ, now);
    const pulled = await prisma.ivmsTruckDay.findFirst({ where: { tenantId, truckId, deliveryDate: dateOnly(today), lastPullAt: { not: null } }, select: { id: true, suppressedAt: true } });
    if (pulled && !pulled.suppressedAt) {
      await prisma.ivmsTruckDay.update({ where: { id: pulled.id }, data: { suppressedAt: now, suppressReason: 'REMAP' } });
      suppressedToday = true;
    }
  }
  await audit({
    tenantId,
    userId: actor.userId,
    action: 'UPDATE',
    entity: 'Truck',
    entityId: truckId,
    beforeJson: { truck: truck.code, gpsTracker: imeiTail(truck.ivmsImei) },
    afterJson: { truck: truck.code, gpsTracker: imeiTail(imei), ...(suppressedToday ? { gpsTimesToday: 'suppressed (tracker changed)' } : {}) },
    ip: actor.ip,
  });
  return { ok: true, truckId, imei, changed: true, suppressedToday };
}

/**
 * One USER_GET_OBJECTS call for the admin's tracker picker, counted in the ADMIN class of the daily
 * allowance (budget only, no lease: review M13) by the provider client (lib/ivms/ayun-client.ts). The
 * route passes it in; without one (null) the picker answers NOT_CONFIGURED and the admin types the IMEI
 * from the Ayun portal.
 */
export type TrackerListCall = (tenantId: string, now: Date) => Promise<AyunResult<unknown>>;

export type TrackerSuggestionsResult =
  | { ok: true; suggestions: (TrackerSuggestion & { truckCode: string })[]; unmatchedTrackers: number; trackers: number }
  | { ok: false; reason: 'MODE_OFF' | 'OTHER_COMPANY' | AyunErrorKind; message: string };

const REASON_TEXT: Partial<Record<AyunErrorKind | 'MODE_OFF' | 'OTHER_COMPANY', string>> = {
  MODE_OFF: 'GPS tracking is OFF: RouteIQ does not call Ayun. Type the IMEI from the Ayun portal, or set GPS tracking to MAP first.',
  OTHER_COMPANY: 'The Ayun account set up on the server belongs to another company.',
  NOT_CONFIGURED: 'Suggestions from Ayun are not available (the server variables are not set). Type the IMEI from the Ayun portal.',
  DISABLED: 'GPS tracking is switched off on the server (ROUTEIQ_DISABLE_IVMS).',
  LIMIT: "Today's Ayun allowance is used up; try again after 04:00 or type the IMEI.",
  AUTH: 'Ayun refused the API key: ask the owner to check AYUN_API_KEY.',
};

/** Suggestions for the company's trucks without a tracker (one provider call). Never a name or plate. */
export async function trackerSuggestions(tenantId: string, trackerListCall: TrackerListCall | null, now: Date = new Date()): Promise<TrackerSuggestionsResult> {
  const env = readIvmsEnv();
  const [tenant, cfg] = await Promise.all([
    prisma.tenant.findFirst({ where: { id: tenantId }, select: { slug: true } }),
    prisma.tenantConfig.findFirst({ where: { tenantId }, select: { ivmsMode: true } }),
  ]);
  if (env.disabled) return { ok: false, reason: 'DISABLED', message: REASON_TEXT.DISABLED! };
  if (!ivmsModeAtLeast(ivmsModeOf(cfg), 'MAP')) return { ok: false, reason: 'MODE_OFF', message: REASON_TEXT.MODE_OFF! };
  if (!ivmsApiReady(env) || !trackerListCall) return { ok: false, reason: 'NOT_CONFIGURED', message: REASON_TEXT.NOT_CONFIGURED! };
  if (!tenant || env.tenantSlug !== tenant.slug.toLowerCase()) return { ok: false, reason: 'OTHER_COMPANY', message: REASON_TEXT.OTHER_COMPANY! };
  const r = await trackerListCall(tenantId, now);
  if (!r.ok) return { ok: false, reason: r.kind, message: REASON_TEXT[r.kind] ?? `Ayun did not answer (${r.kind}). Type the IMEI, or try again later.` };
  const rows = trackerRowsOf(r.data, now, env.apiTimeOffsetMin);
  if (!rows) return { ok: false, reason: 'PARSE', message: 'Ayun answered something RouteIQ cannot read. Type the IMEI from the Ayun portal.' };
  const trucks = await prisma.truck.findMany({ where: { tenantId, active: true, onlyOnDate: null }, select: { id: true, code: true, ivmsImei: true } });
  const s = suggestTrackers(trucks, rows);
  const codeOf = new Map(trucks.map((t) => [t.id, t.code]));
  return { ok: true, suggestions: s.suggestions.map((x) => ({ ...x, truckCode: codeOf.get(x.truckId) ?? '' })), unmatchedTrackers: s.unmatchedTrackers, trackers: s.trackers };
}
