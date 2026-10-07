/**
 * The identity of a physical stop and of a load on the driver page (fix of 7 Oct 2026). Browser-safe
 * and pure: the server, the page and the offline queue all build and read keys here.
 *
 * One driver link covers every load of one truck on one date, and two depots' plans can both give the
 * same truck a Load 1. A key of the load number and the stop alone (`1:2`) then named two stops, and a
 * result entered for the second depot's customer was recorded against the first depot's. The key now
 * holds the depot, as the stored visit does (StopVisit: company, depot, date, truck, load number,
 * stop): a load is `<depotId>:<loadNo>`, a stop `<depotId>:<loadNo>:<sequence>`. A re-plan copies the
 * frozen loads with their numbers and stops, so the key stays the same across plan versions.
 *
 * Keys of the old form (`<loadNo>:<sequence>`, still queued on phones that saved before the update)
 * are read with `depotId: null`: the server accepts them only when exactly one stop of the truck-day
 * matches, and refuses them (STOP_AMBIGUOUS) when more than one does - it never guesses.
 */

/** A depot id as it appears in a key (cuid in the app; letters, digits, _ and - in tests). */
const DEPOT = '[A-Za-z0-9_-]{1,64}';
const STOP_RE = new RegExp(`^(?:(${DEPOT}):)?(\\d{1,3}):(\\d{1,4})$`);
const LOAD_RE = new RegExp(`^(${DEPOT}):(\\d{1,3})$`);

export interface StopRef {
  /** null: a key of the old form, without the depot. */
  depotId: string | null;
  loadNo: number;
  sequence: number;
}

/** The key of a load of the truck-day. */
export function loadKeyOf(depotId: string, loadNo: number): string {
  return `${depotId}:${loadNo}`;
}

/** The key of a stop of the truck-day. */
export function stopKeyOf(depotId: string, loadNo: number, sequence: number): string {
  return `${depotId}:${loadNo}:${sequence}`;
}

/** A stop key of either form, or null when it is not one. A depot made only of digits is never read as a load number. */
export function parseStopKey(s: string): StopRef | null {
  const m = STOP_RE.exec(s);
  if (!m) return null;
  return { depotId: m[1] ?? null, loadNo: Number(m[2]), sequence: Number(m[3]) };
}

/** A load key (`<depotId>:<loadNo>`), or null. */
export function parseLoadKey(s: string): { depotId: string; loadNo: number } | null {
  const m = LOAD_RE.exec(s);
  return m ? { depotId: m[1]!, loadNo: Number(m[2]) } : null;
}

/**
 * The load a stop key belongs to: its load key, or for a key of the old form the load number alone
 * (`"1"`), which only an old queue item carries.
 */
export function loadKeyOfStop(stopKey: string): string {
  const r = parseStopKey(stopKey);
  if (!r) return '';
  return r.depotId === null ? String(r.loadNo) : loadKeyOf(r.depotId, r.loadNo);
}

/** Whether a key is of the old form (no depot). */
export function isLegacyStopKey(stopKey: string): boolean {
  return parseStopKey(stopKey)?.depotId === null;
}
