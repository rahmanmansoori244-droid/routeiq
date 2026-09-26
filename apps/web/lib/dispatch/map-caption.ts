/**
 * What the plan map says under itself about its lines (components/plan-map.tsx). Pure, so the rules
 * are tested: the caption never claims road shapes (OSRM) while any line is straight, says how many
 * loads are straight when only some are, never blames a cause that is not the one, and offers Retry
 * only when asking again can help.
 */
import type { EstimateReason } from '@/lib/dispatch/load-geometry';

export interface ShapeRow {
  estimated: boolean;
  /** Missing on an answer from a web older than this field: treated as worth a retry. */
  reason?: EstimateReason | null;
}

export type RoadShapesState<R extends ShapeRow = ShapeRow> =
  | { status: 'loading' }
  /** The request itself failed (network, 5xx, bad body): every load is drawn straight. */
  | { status: 'failed' }
  | { status: 'ready'; rows: R[] };

export interface RoadShapesCaption {
  text: string;
  /** A warning (amber) rather than a plain note. */
  warn: boolean;
  /** Show the Retry button. */
  canRetry: boolean;
}

export const LOADING_TEXT = 'Loading road shapes…';
export const FAILED_TEXT = 'Road shapes could not be loaded - straight lines shown.';
export const ROAD_TEXT = 'Lines follow the road network (OSRM).';

/** Reasons where asking again can give road shapes (solver restart, slow answer): the Retry button. */
const RETRYABLE: ReadonlySet<EstimateReason> = new Set<EstimateReason>(['ROUTING_ERROR', 'TIMEOUT']);

const isRetryable = (r: ShapeRow) => r.estimated && (!r.reason || RETRYABLE.has(r.reason));

/**
 * True when some lines are straight for a reason the one automatic retry a few seconds later is likely
 * to fix: the request failed, or the solver or OSRM gave an error (a restart). Not for loads that only
 * timed out: routing was then hanging for 15 s or more, and the solver keeps working on each abandoned
 * call for up to about a minute, so an automatic second round would mostly add load to it; the Retry
 * button stays.
 */
export function shouldAutoRetry(s: RoadShapesState): boolean {
  if (s.status === 'failed') return true;
  return s.status === 'ready' && s.rows.some((r) => r.estimated && (!r.reason || r.reason === 'ROUTING_ERROR'));
}

export function roadShapesCaption(s: RoadShapesState, opts: { retrying?: boolean } = {}): RoadShapesCaption {
  const retrying = !!opts.retrying;
  const withRetrying = (text: string) => (retrying ? `${text} Retrying…` : text);
  if (s.status === 'loading') return { text: LOADING_TEXT, warn: false, canRetry: false };
  if (s.status === 'failed') return { text: withRetrying(FAILED_TEXT), warn: true, canRetry: !retrying };

  const n = s.rows.length;
  const est = s.rows.filter((r) => r.estimated);
  const k = est.length;
  if (k === 0) return { text: n ? ROAD_TEXT : 'No lines to show.', warn: false, canRetry: false };

  const canRetry = est.some(isRetryable) && !retrying;
  const reasons = new Set(est.map((r) => r.reason ?? null));
  const only = (r: EstimateReason) => reasons.size === 1 && reasons.has(r);

  const unroutable = only('NOT_ROUTABLE');
  if (k === n) {
    if (only('ROUTING_OFF')) {
      return { text: withRetrying('Straight dashed lines: this company plans on straight-line distances (Settings), so the map has no road shapes.'), warn: false, canRetry };
    }
    if (only('OUTSIDE_COVERAGE')) {
      return { text: withRetrying("Straight dashed lines: the road map covers Oman and the UAE only, so this company's loads have no road shapes."), warn: false, canRetry };
    }
    if (only('NOT_CONFIGURED')) {
      return { text: withRetrying('Straight dashed lines: road routing (OSRM) is not set up, so the map has no road shapes.'), warn: true, canRetry };
    }
    const text = unroutable ? 'Straight dashed lines: the road map could not route these loads (a stop far from any road?).' : FAILED_TEXT;
    return { text: withRetrying(text), warn: true, canRetry };
  }
  // Some loads on roads (e.g. shapes cached earlier), some straight.
  const head = k === 1 ? `1 load of ${n} is drawn as a straight dashed line` : `${k} loads of ${n} are drawn as straight dashed lines`;
  const why = unroutable
    ? k === 1 ? 'the road map could not route it (a stop far from any road?)' : 'the road map could not route them (a stop far from any road?)'
    : k === 1 ? 'its road shape could not be loaded' : 'their road shapes could not be loaded';
  return { text: withRetrying(`${head}: ${why}. The other lines follow the road network (OSRM).`), warn: true, canRetry };
}
