/**
 * Plan continuity (moving an order to another truck than in the previous version costs a
 * penalty) keeps late-order and manual re-plans steady; a re-optimize starts from scratch.
 */
import { describe, expect, it } from 'vitest';
import { usesPlanContinuity } from '@/lib/dispatch/plan-service';

describe('usesPlanContinuity', () => {
  it('applies to late-order and manual re-plans', () => {
    expect(usesPlanContinuity({ parentRunId: 'v1', reason: 'LATE_ORDER' })).toBe(true);
    expect(usesPlanContinuity({ parentRunId: 'v1', reason: 'MANUAL_ADJUSTMENT' })).toBe(true);
  });

  it('does not apply to a re-optimize or to a first plan', () => {
    expect(usesPlanContinuity({ parentRunId: 'v1', reason: 'REOPTIMIZE' })).toBe(false);
    expect(usesPlanContinuity({ parentRunId: null, reason: 'INITIAL' })).toBe(false);
  });
});
