/**
 * The driver page's offline queue (owner request 4 Oct 2026, spec sections 13.1 to 13.3). Pure core
 * plus the sender, both over a storage adapter (store.ts: IndexedDB, or memory in tests and blocked
 * browsers). Browser-safe.
 *
 * Every action and photo is queued on the phone first and sent when there is signal. Each carries a
 * key made once (a lowercase UUID) that never changes on a retry, so the server never records twice.
 * - ready items go out in creation order, actions in batches of up to 50, photos one at a time after
 *   the actions created before them (each held at most 15 s for its position);
 * - held items (arrivals on a trip not dispatched yet) wait until the trip shows DISPATCHED;
 * - draft items are photos of a result being entered: Save turns them ready with the result;
 * - backoff per item 5 s, 15 s, 30 s, 60 s, then every 5 min; never given up while the link works;
 * - 429 is transient: every item stays and the queue waits Retry-After;
 * - 404 / 410 stop sending (the page lists what was not sent); 410 UPLOAD_CLOSED clears the truck-day.
 */
import type { DriverAction, DriverActionResult, DriverResults, LinkStateCode, OutcomeName, PhotoPositionStatusName } from '../driver-link/manifest-types';

export type QueueItemState = 'ready' | 'held' | 'draft';

export interface PhotoBody {
  key: string;
  stop: string;
  /** The device clock when the camera returned (ISO). */
  takenAt: string;
  positionStatus: PhotoPositionStatusName;
  pos?: { lat: number; lng: number; accuracyM: number; at: string } | null;
  exif?: { lat?: number | null; lng?: number | null; takenAt?: string | null } | null;
  fileLastModified?: string | null;
  oldPhoto?: boolean;
  /** The photo waits for its position until then (ms); it is sent anyway after it. */
  positionUntil?: number | null;
  width?: number | null;
  height?: number | null;
}

export interface QueueItem {
  key: string;
  /** `${truckId}|${date}`: a reissued link on the same phone picks up the waiting items. */
  ns: string;
  kind: 'action' | 'photo';
  state: QueueItemState;
  createdAt: number;
  attempts: number;
  nextAt: number;
  /** The stop (`loadNo:sequence`); null for Back at depot. */
  stopKey: string | null;
  loadNo: number;
  body: DriverAction | PhotoBody;
  /** The photo (a Blob; a base64 string where storing a Blob failed). */
  blob?: Blob | string | null;
}

/** The stop sheet being filled in (kept on every change, so a reload or a killed tab loses nothing). */
export interface Draft {
  outcome: OutcomeName | null;
  reason: string | null;
  note: string;
  /** Delivered cases per line (Partly). */
  lines: Record<string, number>;
  /** Photos used for this result (queue items in state draft). */
  photoKeys: string[];
  /** The key of a photo whose camera was open (the tab may have been killed before it came back). */
  pendingPhotoKey: string | null;
  noPhoto: boolean;
  savedAt: number;
}

/** What the phone last sent per stop, to tell "changed by the office / another phone". */
export type SentMap = Record<string, { outcome: OutcomeName | null; at: string }>;

export interface StoredManifest<M = unknown> {
  manifest: M;
  savedAt: number;
  sent: SentMap;
}

export interface LinkEntry {
  ns: string;
  trackingOn: boolean;
}

/** The storage adapter (store.ts). Every method resolves; a failure is the adapter's to report. */
export interface QueueStore {
  readonly persistent: boolean;
  items(ns: string): Promise<QueueItem[]>;
  put(items: QueueItem[]): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** Save: the named draft photos become ready, the stop's other drafts go, the action is added - in one transaction. */
  commit(ns: string, stopKey: string, photoKeys: string[], action: QueueItem): Promise<void>;
  /** Cancel: the stop's draft photos and its draft are deleted. */
  dropDrafts(ns: string, stopKey: string): Promise<void>;
  getDraft(ns: string, stopKey: string): Promise<Draft | null>;
  drafts(ns: string): Promise<Record<string, Draft>>;
  putDraft(ns: string, stopKey: string, draft: Draft): Promise<void>;
  getManifest<M>(ns: string): Promise<StoredManifest<M> | null>;
  putManifest<M>(ns: string, value: StoredManifest<M>): Promise<void>;
  getLink(tokenHash16: string): Promise<LinkEntry | null>;
  putLink(tokenHash16: string, entry: LinkEntry): Promise<void>;
  namespaces(): Promise<string[]>;
  /** Delete a truck-day: its queue, drafts, manifest and link entries. */
  clearNamespace(ns: string): Promise<void>;
}

export const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000] as const;
export const BACKOFF_LONG_MS = 5 * 60_000;
export const MAX_BATCH = 50;
/** A photo waits this long for its position at most. */
export const PHOTO_POSITION_WAIT_MS = 15_000;
/** A truck-day is deleted from the phone once its date is this many days before the phone's date. */
export const KEEP_DAYS = 5;

/** The wait after the n-th failed attempt (1-based): 5 s, 15 s, 30 s, 60 s, then every 5 min. */
export function backoff(attempts: number): number {
  if (attempts <= 0) return 0;
  return BACKOFF_MS[attempts - 1] ?? BACKOFF_LONG_MS;
}

export function nsOf(truckId: string, date: string): string {
  return `${truckId}|${date}`;
}

const byCreated = (a: QueueItem, b: QueueItem) => a.createdAt - b.createdAt || a.key.localeCompare(b.key);

/**
 * What to send now: the due ready actions in creation order (up to 50), and the earliest due ready
 * photo that no earlier ready action is still waiting for, once its position came or its wait is over.
 */
export function nextBatch(items: readonly QueueItem[], now: number, max = MAX_BATCH): { actions: QueueItem[]; photo: QueueItem | null } {
  const ready = items.filter((i) => i.state === 'ready').sort(byCreated);
  const actions = ready.filter((i) => i.kind === 'action' && i.nextAt <= now).slice(0, max);
  const pendingActions = ready.filter((i) => i.kind === 'action');
  const photo =
    ready.find((i) => {
      if (i.kind !== 'photo' || i.nextAt > now) return false;
      const until = (i.body as PhotoBody).positionUntil;
      if (until && until > now) return false;
      return !pendingActions.some((a) => a.createdAt < i.createdAt);
    }) ?? null;
  return { actions, photo };
}

export type ResultClass = 'remove' | 'drop' | 'hold' | 'retry';

/** ok / duplicate: done; refused: dropped and shown, except an arrival before dispatch (held); error: retried. */
export function classify(r: Pick<DriverActionResult, 'status' | 'transient'> | undefined): ResultClass {
  if (!r) return 'retry';
  if (r.status === 'ok' || r.status === 'duplicate') return 'remove';
  if (r.status === 'refused') return r.transient ? 'hold' : 'drop';
  return 'retry';
}

export interface Report {
  key: string;
  stopKey: string | null;
  code: string;
  message: { en: string; ar: string } | null;
  type: string;
}

export interface Applied {
  remove: string[];
  update: QueueItem[];
  report: Report[];
  /** Results the server stored, per stop (the "changed by the office" check). */
  sent: SentMap;
}

/** The answers of one batch applied to its items (pure). */
export function applyResults(batch: readonly QueueItem[], results: readonly DriverActionResult[], now: number): Applied {
  const byKey = new Map(results.map((r) => [r.key, r]));
  const out: Applied = { remove: [], update: [], report: [], sent: {} };
  for (const item of batch) {
    const r = byKey.get(item.key);
    const c = classify(r);
    const body = item.body as DriverAction;
    if (c === 'remove') {
      out.remove.push(item.key);
      if (item.kind === 'action' && body.type === 'OUTCOME' && item.stopKey) out.sent[item.stopKey] = { outcome: body.outcome, at: body.at };
    } else if (c === 'drop') {
      out.remove.push(item.key);
      out.report.push({ key: item.key, stopKey: item.stopKey, code: r?.code ?? 'INVALID', message: r?.message ?? null, type: item.kind === 'photo' ? 'PHOTO' : body.type });
    } else if (c === 'hold') {
      out.update.push({ ...item, state: 'held', attempts: 0, nextAt: now });
    } else {
      const attempts = item.attempts + 1;
      out.update.push({ ...item, attempts, nextAt: now + backoff(attempts) });
    }
  }
  return out;
}

/** A whole request failed (busy, 5xx, network): every item of it waits its next backoff (pure). */
export function retryAll(batch: readonly QueueItem[], now: number): QueueItem[] {
  return batch.map((i) => {
    const attempts = i.attempts + 1;
    return { ...i, attempts, nextAt: now + backoff(attempts) };
  });
}

/** Held arrivals and departures of trips now on the road (or done) become ready, with their original times (pure). */
export function releaseHeld(items: readonly QueueItem[], outLoads: ReadonlySet<number>, now: number): QueueItem[] {
  return items.filter((i) => i.state === 'held' && outLoads.has(i.loadNo)).map((i) => ({ ...i, state: 'ready' as const, nextAt: now, attempts: 0 }));
}

/** "Waiting to send (n)": ready items (held arrivals and drafts are not counted). */
export function waitingCount(items: readonly QueueItem[]): number {
  return items.filter((i) => i.state === 'ready').length;
}

/** Truck-days whose date is 5 or more days before the phone's date (their upload window has ended). */
export function staleNamespaces(nss: readonly string[], phoneTodayIso: string): string[] {
  const today = Date.parse(`${phoneTodayIso}T00:00:00Z`);
  return nss.filter((ns) => {
    const d = Date.parse(`${ns.split('|')[1] ?? ''}T00:00:00Z`);
    return Number.isFinite(d) && Number.isFinite(today) && today - d >= KEEP_DAYS * 86_400_000;
  });
}

// ---------------------------------------------------------------------------------------
// Answers of the send requests
// ---------------------------------------------------------------------------------------

export type SendAnswer =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'retry' }
  | { kind: 'pause'; ms: number }
  | { kind: 'dead'; code: LinkStateCode }
  | { kind: 'closed' }
  /** A whole request refused for good (a photo too large, not a JPEG, over the photo limit). */
  | { kind: 'drop'; code: string; message: string | null };

/** How a POST answer reads (pure). */
export function readSendAnswer(status: number, body: unknown, retryAfter: string | null): SendAnswer {
  const b = (body ?? {}) as { data?: unknown; error?: unknown };
  const err = (b.error && typeof b.error === 'object' ? b.error : {}) as { code?: unknown; message?: unknown; error?: unknown };
  const code = typeof err.code === 'string' ? err.code : '';
  if (status === 200 && b.data && typeof b.data === 'object') return { kind: 'ok', data: b.data as Record<string, unknown> };
  if (status === 429) {
    const s = Number(retryAfter);
    return { kind: 'pause', ms: (Number.isFinite(s) && s > 0 ? s : 60) * 1000 };
  }
  if (status === 410 && code === 'UPLOAD_CLOSED') return { kind: 'closed' };
  if ((status === 404 || status === 410 || status === 503) && /^(LINK_|DRIVER_LINKS_OFF)/.test(code)) return { kind: 'dead', code: code as LinkStateCode };
  if (status === 413 || status === 415 || (status === 409 && (code === 'PHOTO_LIMIT' || code === 'KEY_REUSED'))) {
    const message = typeof err.message === 'string' ? err.message : typeof err.error === 'string' ? err.error : null;
    return { kind: 'drop', code: code || String(status), message };
  }
  return { kind: 'retry' };
}

// ---------------------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------------------

export interface SendDeps {
  store: QueueStore;
  ns: string;
  postActions(actions: DriverAction[]): Promise<{ status: number; body: unknown; retryAfter: string | null }>;
  postPhoto(item: QueueItem): Promise<{ status: number; body: unknown; retryAfter: string | null }>;
  now(): number;
}

export interface FlushResult {
  sent: number;
  reports: Report[];
  results: DriverResults | null;
  sentMap: SentMap;
  /** Wait at least until then before the next request (429). */
  pauseUntil: number | null;
  dead: LinkStateCode | null;
  closed: boolean;
}

/** Sends what is due, round by round (at most `rounds`), and stops at the first request that fails. */
export async function flushQueue(deps: SendDeps, rounds = 20): Promise<FlushResult> {
  const out: FlushResult = { sent: 0, reports: [], results: null, sentMap: {}, pauseUntil: null, dead: null, closed: false };
  for (let round = 0; round < rounds; round++) {
    const items = await deps.store.items(deps.ns);
    const { actions, photo } = nextBatch(items, deps.now());
    if (!actions.length && !photo) break;
    if (actions.length) {
      const res = await deps.postActions(actions.map((a) => a.body as DriverAction));
      const ans = readSendAnswer(res.status, res.body, res.retryAfter);
      if (!(await handleWhole(deps, ans, actions, out))) break;
      if (ans.kind === 'ok') {
        const data = ans.data as { results?: DriverActionResult[]; stops?: DriverResults['stops']; back?: DriverResults['back'] };
        const applied = applyResults(actions, Array.isArray(data.results) ? data.results : [], deps.now());
        await persist(deps, applied);
        out.sent += applied.remove.length - applied.report.length;
        out.reports.push(...applied.report);
        Object.assign(out.sentMap, applied.sent);
        if (data.stops) out.results = { stops: data.stops, back: data.back ?? {} };
      }
      continue;
    }
    if (photo) {
      const res = await deps.postPhoto(photo);
      const ans = readSendAnswer(res.status, res.body, res.retryAfter);
      if (ans.kind === 'drop') {
        await deps.store.remove([photo.key]);
        out.reports.push({ key: photo.key, stopKey: photo.stopKey, code: ans.code, message: null, type: 'PHOTO' });
        continue;
      }
      if (!(await handleWhole(deps, ans, [photo], out))) break;
      if (ans.kind === 'ok') {
        const data = ans.data as { status?: string; code?: string; message?: { en: string; ar: string }; stops?: DriverResults['stops']; back?: DriverResults['back'] };
        const applied = applyResults([photo], [{ key: photo.key, status: (data.status as DriverActionResult['status']) ?? 'error', code: data.code, message: data.message }], deps.now());
        await persist(deps, applied);
        out.sent += applied.remove.length - applied.report.length;
        out.reports.push(...applied.report);
        if (data.stops) out.results = { stops: data.stops, back: data.back ?? {} };
      }
    }
  }
  return out;
}

async function persist(deps: SendDeps, a: Applied) {
  if (a.remove.length) await deps.store.remove(a.remove);
  if (a.update.length) await deps.store.put(a.update);
}

/** A failed whole request: false = stop this flush. */
async function handleWhole(deps: SendDeps, ans: SendAnswer, batch: QueueItem[], out: FlushResult): Promise<boolean> {
  if (ans.kind === 'ok') return true;
  if (ans.kind === 'retry') {
    await deps.store.put(retryAll(batch, deps.now()));
    return false;
  }
  if (ans.kind === 'pause') {
    // Transient: every item stays as it is; the queue waits Retry-After.
    out.pauseUntil = deps.now() + ans.ms;
    return false;
  }
  if (ans.kind === 'dead') {
    out.dead = ans.code;
    return false;
  }
  if (ans.kind === 'closed') {
    out.closed = true;
    return false;
  }
  if (ans.kind === 'drop') {
    // A whole action batch refused for good never happens (bodies are checked per action); keep it.
    await deps.store.put(retryAll(batch, deps.now()));
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------

/** A lowercase v4 UUID: crypto.randomUUID, else getRandomValues formatted as one. */
export function newKey(c: Pick<Crypto, 'getRandomValues'> & { randomUUID?: () => string } = globalThis.crypto): string {
  if (typeof c?.randomUUID === 'function') return c.randomUUID().toLowerCase();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A queue item for an action. */
export function actionItem(ns: string, action: DriverAction, now: number, held = false): QueueItem {
  const stopKey = action.type === 'BACK_AT_DEPOT' ? null : action.stop;
  const loadNo = action.type === 'BACK_AT_DEPOT' ? action.load : Number(action.stop.split(':')[0]);
  return { key: action.key, ns, kind: 'action', state: held ? 'held' : 'ready', createdAt: now, attempts: 0, nextAt: now, stopKey, loadNo, body: action };
}
