/**
 * The driver break in the dispatcher's and the driver's words (plan screen, Excel, driver sheet,
 * WhatsApp): one sentence everywhere. Pure.
 */
import type { LoadBreak } from './snapshots';
import { fmtHhmm } from './time';

/** "12:40-13:40". */
export function breakTimes(b: Pick<LoadBreak, 'startMin' | 'endMin'>): string {
  return `${fmtHhmm(b.startMin)}-${fmtHhmm(b.endMin)}`;
}

/** Where the break is taken, e.g. "between stop 3 and stop 4" or "at the depot before leaving". */
export function breakPlace(b: Pick<LoadBreak, 'where' | 'afterSequence'>, stopCount: number): string {
  if (b.where === 'DEPOT') return 'at the depot before leaving (loading continues meanwhile)';
  const k = b.afterSequence ?? 0;
  if (k <= 0) return 'on the way to stop 1';
  if (k >= stopCount) return 'on the way back to the depot';
  return `between stop ${k} and stop ${k + 1}`;
}

/** "Break 12:40-13:40 between stop 3 and stop 4". */
export function breakLine(b: LoadBreak, stopCount: number): string {
  return `Break ${breakTimes(b)} ${breakPlace(b, stopCount)}`;
}
