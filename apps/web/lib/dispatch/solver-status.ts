/**
 * The route search's own status code (OR-Tools RoutingSearchStatus, e.g.
 * ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED) in plain words for dispatchers - on the plan
 * options table, the Excel SUMMARY and the "no plan found" message (scenario tests S01-S05: the
 * raw code was printed as is).
 *
 * The search is time-limited: it stops at its time limit whatever it reports, so a found plan is
 * "the best plan found in the time allowed", not a proven best. Unknown codes are shown as they are.
 */

const TEXT: Record<string, { short: string; long: string }> = {
  ROUTING_SUCCESS: {
    short: 'best plan found in the time allowed',
    long: 'Best plan found in the time allowed (a good plan, not a proven best).',
  },
  ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED: {
    short: 'best plan found in the time allowed (search stopped at its limit)',
    long: 'Best plan found in the time allowed: the search stopped at its time limit while it could still improve the plan. A re-plan may find a shorter one.',
  },
  ROUTING_OPTIMAL: { short: 'best possible plan', long: 'Best possible plan: the search proved no better one exists.' },
  ROUTING_FAIL_TIMEOUT: { short: 'no plan found in the time allowed', long: 'No plan found in the time allowed.' },
  ROUTING_FAIL: { short: 'no plan found', long: 'No plan found: the search found no way to plan these stops with these trucks and limits.' },
  ROUTING_INFEASIBLE: { short: 'no plan possible', long: 'No plan possible with these trucks and limits.' },
  ROUTING_INVALID: { short: 'could not search', long: "The route search could not start with this day's data." },
  ROUTING_NOT_SOLVED: { short: 'not searched', long: 'The route search did not run.' },
  NOT_RUN: { short: 'no route search needed', long: 'No route search was needed (nothing to plan with the trucks available).' },
};

/**
 * A stored message with a raw status code in it (an unserved reason saved by an older solver:
 * "The optimizer found no feasible plan (ROUTING_FAIL_TIMEOUT).") with the code in plain words.
 */
export function withPlainSolverCodes(text: string | null): string | null {
  return text ? text.replace(/\bROUTING_[A-Z_]+\b/g, (c) => solverStatusText(c, 'short')) : text;
}

/** The search ended with a plan (whether or not it ran to its limit). */
export function isPlanFoundStatus(code: string | null | undefined): boolean {
  return ['ROUTING_SUCCESS', 'ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED', 'ROUTING_OPTIMAL'].includes((code ?? '').trim().toUpperCase());
}

/** Plain words for a route-search status code; `short` for table cells. Unknown codes are returned as they are. */
export function solverStatusText(code: string | null | undefined, form: 'short' | 'long' = 'long'): string {
  const c = (code ?? '').trim();
  if (!c) return form === 'short' ? '—' : 'Not recorded.';
  const t = TEXT[c.toUpperCase()];
  return t ? t[form] : c;
}
