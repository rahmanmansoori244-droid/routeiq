/**
 * The plan map's caption (lib/dispatch/map-caption.ts): it never claims road shapes (OSRM) while a
 * line is straight, counts the straight loads when only some are, explains why, and offers Retry
 * (and the one automatic retry) only when asking again can help.
 */
import { describe, expect, it } from 'vitest';
import type { EstimateReason } from '@/lib/dispatch/load-geometry';
import { FAILED_TEXT, LOADING_TEXT, ROAD_TEXT, roadShapesCaption, shouldAutoRetry, type RoadShapesState, type ShapeRow } from '@/lib/dispatch/map-caption';

const roadRow: ShapeRow = { estimated: false };
const est = (reason?: EstimateReason | null): ShapeRow => ({ estimated: true, reason });
const ready = (...rows: ShapeRow[]): RoadShapesState => ({ status: 'ready', rows });
const many = (n: number, row: ShapeRow) => Array.from({ length: n }, () => row);

describe('roadShapesCaption', () => {
  it('loading: says so, nothing to retry', () => {
    expect(roadShapesCaption({ status: 'loading' })).toEqual({ text: LOADING_TEXT, warn: false, canRetry: false });
  });

  it('the request failed: honest caption and a Retry button (hidden while retrying)', () => {
    expect(roadShapesCaption({ status: 'failed' })).toEqual({ text: 'Road shapes could not be loaded - straight lines shown.', warn: true, canRetry: true });
    expect(roadShapesCaption({ status: 'failed' }, { retrying: true })).toEqual({ text: `${FAILED_TEXT} Retrying…`, warn: true, canRetry: false });
  });

  it('every load on the road network: the only case that names OSRM without a count', () => {
    expect(roadShapesCaption(ready(...many(14, roadRow)))).toEqual({ text: ROAD_TEXT, warn: false, canRetry: false });
  });

  it('every load straight after timeouts or errors: the failure caption with Retry', () => {
    expect(roadShapesCaption(ready(...many(14, est('TIMEOUT'))))).toEqual({ text: FAILED_TEXT, warn: true, canRetry: true });
    expect(roadShapesCaption(ready(est('ROUTING_ERROR'), est('TIMEOUT')))).toEqual({ text: FAILED_TEXT, warn: true, canRetry: true });
  });

  it('mixed: says how many loads are straight and why', () => {
    const c = roadShapesCaption(ready(...many(12, roadRow), est('TIMEOUT'), est('ROUTING_ERROR')));
    expect(c).toEqual({
      text: '2 loads of 14 are drawn as straight dashed lines: their road shapes could not be loaded. The other lines follow the road network (OSRM).',
      warn: true,
      canRetry: true,
    });
    expect(roadShapesCaption(ready(roadRow, roadRow, est('TIMEOUT'))).text).toBe(
      '1 load of 3 is drawn as a straight dashed line: its road shape could not be loaded. The other lines follow the road network (OSRM).',
    );
  });

  it('a load OSRM cannot route: no Retry (the same answer would come back)', () => {
    expect(roadShapesCaption(ready(roadRow, est('NOT_ROUTABLE')))).toEqual({
      text: '1 load of 2 is drawn as a straight dashed line: the road map could not route it (a stop far from any road?). The other lines follow the road network (OSRM).',
      warn: true,
      canRetry: false,
    });
    expect(roadShapesCaption(ready(est('NOT_ROUTABLE'), est('NOT_ROUTABLE')))).toEqual({
      text: 'Straight dashed lines: the road map could not route these loads (a stop far from any road?).',
      warn: true,
      canRetry: false,
    });
  });

  it('routing off for the company or not set up: explains it, no Retry', () => {
    expect(roadShapesCaption(ready(est('ROUTING_OFF'), est('ROUTING_OFF')))).toEqual({
      text: 'Straight dashed lines: this company plans on straight-line distances (Settings), so the map has no road shapes.',
      warn: false,
      canRetry: false,
    });
    expect(roadShapesCaption(ready(est('NOT_CONFIGURED')))).toEqual({
      text: 'Straight dashed lines: road routing (OSRM) is not set up, so the map has no road shapes.',
      warn: true,
      canRetry: false,
    });
  });

  it('outside the shared road map: says so and does not send the user to Settings (Settings still say OSRM)', () => {
    const c = roadShapesCaption(ready(est('OUTSIDE_COVERAGE'), est('OUTSIDE_COVERAGE')));
    expect(c).toEqual({
      text: "Straight dashed lines: the road map covers Oman and the UAE only, so this company's loads have no road shapes.",
      warn: false,
      canRetry: false,
    });
    expect(c.text).not.toMatch(/Settings/);
  });

  it('an OSRM outage ("No route to host") reaches the caption as ROUTING_ERROR: failure text with Retry, never "far from any road"', () => {
    const c = roadShapesCaption(ready(...many(14, est('ROUTING_ERROR'))));
    expect(c).toEqual({ text: FAILED_TEXT, warn: true, canRetry: true });
    expect(c.text).not.toMatch(/far from any road/);
  });

  it('cached road shapes plus "not configured" for the rest: a count, not "the map has no road shapes"', () => {
    expect(roadShapesCaption(ready(roadRow, est('NOT_CONFIGURED')))).toEqual({
      text: '1 load of 2 is drawn as a straight dashed line: its road shape could not be loaded. The other lines follow the road network (OSRM).',
      warn: true,
      canRetry: false,
    });
  });

  it('an answer without reasons (older server) is treated as worth a retry', () => {
    expect(roadShapesCaption(ready(roadRow, est()))).toMatchObject({ canRetry: true, warn: true });
    expect(roadShapesCaption(ready(est(null)))).toEqual({ text: FAILED_TEXT, warn: true, canRetry: true });
  });

  it('never claims OSRM for all lines while any line is straight', () => {
    const reasons: (EstimateReason | undefined)[] = ['ROUTING_OFF', 'OUTSIDE_COVERAGE', 'NOT_CONFIGURED', 'NOT_ROUTABLE', 'ROUTING_ERROR', 'TIMEOUT', undefined];
    for (const r of reasons) {
      for (const roads of [0, 1, 5]) {
        for (const straight of [1, 3]) {
          for (const retrying of [false, true]) {
            const c = roadShapesCaption(ready(...many(roads, roadRow), ...many(straight, est(r))), { retrying });
            expect(c.text).not.toBe(ROAD_TEXT);
            expect(c.text).toMatch(/straight/i);
            if (roads === 0) expect(c.text).not.toMatch(/follow the road network/);
            else expect(c.text).toMatch(new RegExp(`^${straight} loads? of ${roads + straight} `));
          }
        }
      }
    }
  });

  it('no rows: no claim either way', () => {
    expect(roadShapesCaption(ready())).toEqual({ text: 'No lines to show.', warn: false, canRetry: false });
  });
});

describe('shouldAutoRetry', () => {
  it('retries a failed request or loads the solver or OSRM gave an error for (a restart)', () => {
    expect(shouldAutoRetry({ status: 'failed' })).toBe(true);
    expect(shouldAutoRetry(ready(est('ROUTING_ERROR')))).toBe(true);
    expect(shouldAutoRetry(ready(roadRow, est('TIMEOUT'), est('ROUTING_ERROR')))).toBe(true);
    expect(shouldAutoRetry(ready(est()))).toBe(true);
  });

  it('does not retry by itself when nothing is missing, a retry cannot help, or routing was hanging (timeouts: Retry button only)', () => {
    expect(shouldAutoRetry({ status: 'loading' })).toBe(false);
    expect(shouldAutoRetry(ready(roadRow, roadRow))).toBe(false);
    expect(shouldAutoRetry(ready(est('ROUTING_OFF')))).toBe(false);
    expect(shouldAutoRetry(ready(est('OUTSIDE_COVERAGE')))).toBe(false);
    expect(shouldAutoRetry(ready(est('NOT_CONFIGURED')))).toBe(false);
    expect(shouldAutoRetry(ready(roadRow, est('NOT_ROUTABLE')))).toBe(false);
    // Each timed-out call keeps a solver thread busy for up to a minute: no automatic second round.
    expect(shouldAutoRetry(ready(roadRow, est('TIMEOUT')))).toBe(false);
    expect(shouldAutoRetry(ready(...many(14, est('TIMEOUT'))))).toBe(false);
    expect(roadShapesCaption(ready(...many(14, est('TIMEOUT'))))).toMatchObject({ canRetry: true });
  });
});
