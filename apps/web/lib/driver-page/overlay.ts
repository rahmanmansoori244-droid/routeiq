/**
 * What the driver page shows: the server's state plus what is still on the phone (owner request
 * 4 Oct 2026, spec section 13.5). Pure, browser-safe. The stop list, the stop sheet and the tracker all
 * read this overlay, never the bare manifest, so a result saved without signal is never offered again
 * (which would record a second result and more photos).
 *
 * - an unsent result shows with "Saved on phone - waiting to send" and ends the stop for the tracker;
 * - an unsent arrival shows "Arrived 10:02" and the running timer;
 * - an unsent Back at depot closes the trip on the phone (the tracker moves to the next trip);
 * - a server result that differs from what this phone sent, with nothing left to send for the stop,
 *   shows "Changed by office / another phone" instead of flipping silently.
 */
import type { DriverAction, DriverManifest, ManifestLoad, ManifestStop, NotDeliveredReasonName, OutcomeName } from '../driver-link/manifest-types';
import { parseStopKey } from '../driver-link/stop-key';
import { itemLoadKey, type QueueItem, type SentMap } from './queue';

export interface StopView {
  state: 'PENDING' | 'ARRIVED' | 'DONE';
  arrivedAt: number | null;
  arrivalObserved: boolean;
  /** The result time (the tracker's doneAt); null = no result. */
  doneAt: number | null;
  outcome: OutcomeName | null;
  reason: NotDeliveredReasonName | null;
  note: string | null;
  casesDelivered: number | null;
  lines: { lineId: string; delivered: number }[] | null;
  minutes: number | null;
  /** A result or an arrival of this stop is still on the phone. */
  pending: boolean;
  changedByOffice: boolean;
  photoIds: string[];
  /** Photos of this stop still on the phone (sent later). */
  localPhotos: number;
  /**
   * Photo keys named by the driver's Delivered and Partly results: the server's count plus the
   * results still queued on the phone (sent before their photos, so the server counts them too).
   * A changed result needs no new photo when there is one; a Not delivered's photos do not count.
   */
  proofPhotos: number;
  noPhotoReason: string | null;
  late: boolean;
  editable: boolean;
  carriedTo: string | null;
  by: 'DRIVER' | 'OFFICE' | null;
}

export type OverlayStop = ManifestStop & { view: StopView };
export type OverlayLoad = Omit<ManifestLoad, 'stops'> & { stops: OverlayStop[]; back: boolean; backAt: number | null; backPending: boolean };

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

function countCases(stop: ManifestStop, outcome: OutcomeName | null, lines: { lineId: string; delivered: number }[] | null | undefined): number | null {
  if (!outcome) return null;
  if (outcome === 'DELIVERED') return stop.cases;
  if (outcome === 'NOT_DELIVERED') return 0;
  const all = stop.orders.flatMap((o) => o.lines);
  const sent = new Map((lines ?? []).map((l) => [l.lineId, l.delivered]));
  return all.reduce((a, l) => a + (sent.get(l.lineId) ?? l.cases), 0);
}

/** The photo keys of the Delivered and Partly results still queued for a stop (proof, as the server will count them). */
function queuedProofKeys(outcomes: readonly QueueItem[]): Set<string> {
  const keys = new Set<string>();
  for (const i of outcomes) {
    const b = i.body as Extract<DriverAction, { type: 'OUTCOME' }>;
    if (b.outcome !== 'DELIVERED' && b.outcome !== 'PARTLY_DELIVERED') continue;
    for (const k of b.photoKeys ?? []) keys.add(k);
  }
  return keys;
}

type KeyedLoad = Pick<ManifestLoad, 'key' | 'loadNo'> & { stops: readonly Pick<ManifestStop, 'key' | 'sequence'>[] };

/**
 * The manifest stop a queued stop key means (pure): the key itself, or for a key saved before the
 * update of 7 Oct 2026 (no depot, stop-key.ts) the one stop of that trip number and stop - null when
 * two trips of that number have it (the server refuses such an entry: STOP_AMBIGUOUS) or none does.
 */
export function manifestStopKey(loads: readonly KeyedLoad[], key: string): string | null {
  const r = parseStopKey(key);
  if (!r) return null;
  if (r.depotId !== null) return key;
  const fits = loads.flatMap((l) => (l.loadNo === r.loadNo ? l.stops.filter((s) => s.sequence === r.sequence).map((s) => s.key) : []));
  return fits.length === 1 ? fits[0]! : null;
}

/** The manifest load a queued item belongs to (pure): its load key, or for an old item the one load of that number. */
export function manifestLoadKey(loads: readonly KeyedLoad[], item: QueueItem): string | null {
  const k = itemLoadKey(item);
  if (k.includes(':')) return k;
  const fits = loads.filter((l) => String(l.loadNo) === k);
  return fits.length === 1 ? fits[0]!.key : null;
}

/**
 * A manifest the page kept on the phone before the update of 7 Oct 2026 has no load keys and old stop
 * keys (`loadNo:sequence`): its loads take their number as the key until the next manifest arrives, and
 * entries made from it are sent with the old keys, which the server accepts only when one stop fits.
 */
export function keyedManifest<M extends Pick<DriverManifest, 'loads'>>(m: M): M {
  if (m.loads.every((l) => typeof l.key === 'string' && typeof l.depotId === 'string')) return m;
  return { ...m, loads: m.loads.map((l) => ({ ...l, key: typeof l.key === 'string' ? l.key : String(l.loadNo), depotId: typeof l.depotId === 'string' ? l.depotId : '' })) };
}

/** The overlay of the unsent and held items on the last manifest (pure). */
export function applyQueued(m: Pick<DriverManifest, 'loads'>, items: readonly QueueItem[], sent: SentMap = {}): OverlayLoad[] {
  const live = items.filter((i) => i.state !== 'draft');
  const actions = live.filter((i) => i.kind === 'action').sort((a, b) => a.createdAt - b.createdAt);
  // The stop each item is for, read once (an old key without the depot only where one stop fits it).
  const stopOf = new Map(live.map((i) => [i, i.stopKey ? manifestStopKey(m.loads, i.stopKey) : null] as const));
  return m.loads.map((l) => {
    const backItem = actions.find((i) => (i.body as DriverAction).type === 'BACK_AT_DEPOT' && manifestLoadKey(m.loads, i) === l.key);
    const serverBack = ms(l.backAtDepotAt);
    const backAt = serverBack ?? (backItem ? ms((backItem.body as DriverAction).at) : null);
    return {
      ...l,
      back: backAt !== null,
      backAt,
      backPending: serverBack === null && !!backItem,
      stops: l.stops.map((s) => ({ ...s, view: stopView(s, l, actions.filter((i) => stopOf.get(i) === s.key), live.filter((i) => i.kind === 'photo' && stopOf.get(i) === s.key).length, sent[s.key]) })),
    };
  });
}

function stopView(s: ManifestStop, l: ManifestLoad, mine: QueueItem[], localPhotos: number, sentByPhone: SentMap[string] | undefined): StopView {
  const r = s.result;
  const outcomes = mine.filter((i) => (i.body as DriverAction).type === 'OUTCOME');
  const arrivals = mine.filter((i) => (i.body as DriverAction).type === 'ARRIVE');
  const lastOutcome = outcomes.at(-1)?.body as Extract<DriverAction, { type: 'OUTCOME' }> | undefined;
  const firstArrival = arrivals[0]?.body as Extract<DriverAction, { type: 'ARRIVE' }> | undefined;
  const base: StopView = {
    state: r?.state ?? 'PENDING',
    arrivedAt: ms(r?.arrivedAt),
    arrivalObserved: r?.arrivalObserved ?? true,
    doneAt: r?.outcome ? ms(r.outcomeAt) : null,
    outcome: r?.outcome ?? null,
    reason: r?.reason ?? null,
    note: r?.note ?? null,
    casesDelivered: r?.casesDelivered ?? null,
    lines: r?.lines ?? null,
    minutes: r?.minutes ?? null,
    pending: false,
    changedByOffice: false,
    photoIds: r?.photoIds ?? [],
    localPhotos,
    proofPhotos: (r?.proofPhotos ?? 0) + queuedProofKeys(outcomes).size,
    noPhotoReason: r?.noPhotoReason ?? null,
    late: r?.late ?? false,
    editable: r ? r.editable : l.status === 'DISPATCHED',
    carriedTo: r?.carriedTo ?? null,
    by: r?.by ?? null,
  };
  if (firstArrival && base.arrivedAt === null) {
    base.arrivedAt = ms(firstArrival.at);
    base.arrivalObserved = firstArrival.observed !== false;
    base.state = base.outcome ? 'DONE' : 'ARRIVED';
    base.pending = true;
  }
  if (lastOutcome) {
    base.outcome = lastOutcome.outcome;
    base.reason = lastOutcome.reason ?? null;
    base.note = lastOutcome.note ?? null;
    base.lines = lastOutcome.lines ?? null;
    base.casesDelivered = countCases(s, lastOutcome.outcome, lastOutcome.lines);
    base.doneAt = lastOutcome.outcome ? ms(lastOutcome.at) : null;
    base.state = lastOutcome.outcome ? 'DONE' : base.arrivedAt !== null ? 'ARRIVED' : 'PENDING';
    base.noPhotoReason = lastOutcome.noPhotoReason ?? null;
    base.by = 'DRIVER';
    base.pending = true;
  }
  if (!mine.length && sentByPhone && r && (r.outcome ?? null) !== sentByPhone.outcome) base.changedByOffice = true;
  return base;
}

/** The stop in progress for restoreTracker: a server ARRIVED stop or an unsent arrival without a result. */
export function stopInProgress(loads: readonly OverlayLoad[], loadKey: string): { key: string; arrivedAt: number; observed: boolean } | null {
  const l = loads.find((x) => x.key === loadKey);
  const s = l?.stops.find((x) => x.view.state === 'ARRIVED' && x.view.arrivedAt !== null && x.view.doneAt === null);
  return s ? { key: s.key, arrivedAt: s.view.arrivedAt!, observed: s.view.arrivalObserved } : null;
}

/** The truck-day's unsent results for the "link replaced" page: stop, result, time. */
export function unsentList(loads: readonly OverlayLoad[], items: readonly QueueItem[]): { stopKey: string; customer: string; outcome: OutcomeName | null; at: string }[] {
  const names = new Map(loads.flatMap((l) => l.stops.map((s) => [s.key, s.customerName] as const)));
  return items
    .filter((i) => i.kind === 'action' && i.state !== 'draft' && (i.body as DriverAction).type === 'OUTCOME')
    .map((i) => {
      const b = i.body as Extract<DriverAction, { type: 'OUTCOME' }>;
      const k = manifestStopKey(loads, b.stop);
      return { stopKey: b.stop, customer: (k ? names.get(k) : undefined) ?? b.stop, outcome: b.outcome, at: b.at };
    });
}
