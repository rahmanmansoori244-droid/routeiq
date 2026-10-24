/**
 * The receiving-hours rule (TenantConfig.windowRule, owner request 13 Oct 2026: "14:00 IS the latest
 * arrival"). What the END of a customer's receiving hours means for the planner:
 * - 'FINISH' (the default, owner rule 29 Sep 2026): unloading must be FINISHED by then;
 * - 'START': the end is the LATEST ARRIVAL - unloading must start by then and may continue after it.
 * The optimizer applies it (DispatchConfig.window_rule, load_repack.latest_start_s) and echoes the rule it
 * planned with (DispatchScenario.window_rule); each load keeps that echo (PlanRules.windowRule) and every
 * check and text of the load follows it, never today's setting.
 *
 * Pure: shared by the server, the Settings page and the workbook.
 */

export const WINDOW_RULES = ['START', 'FINISH'] as const;
export type WindowRule = (typeof WINDOW_RULES)[number];

/** Every company plans with FINISH until a company admin changes it (the schema default too). */
export const WINDOW_RULE_DEFAULT: WindowRule = 'FINISH';

/** The rule a settings row asks for: 'START' only when set to it, else the default. */
export function windowRuleOf(cfg: { windowRule?: string | null } | null | undefined): WindowRule {
  return cfg?.windowRule === 'START' ? 'START' : WINDOW_RULE_DEFAULT;
}

/** A rule as echoed or stored ('START' / 'FINISH'), else null (an older plan, made before the echo). */
export function echoedWindowRule(v: unknown): WindowRule | null {
  return v === 'START' || v === 'FINISH' ? v : null;
}

/** The Settings choice, as the page shows it. */
export const WINDOW_RULE_CHOICES: Record<WindowRule, { label: string; hint: string }> = {
  START: {
    label: 'Receiving hours end = latest arrival (unloading may continue after it)',
    hint: 'A truck may arrive up to the end of the receiving hours (a shop open until 14:00 may get a truck at 13:50) and unloading may run past it.',
  },
  FINISH: {
    label: 'Unloading must be finished by the end of the receiving hours',
    hint: 'A truck must arrive early enough to finish unloading by the end of the receiving hours (90 min of unloading for a 14:00 close: arrival by 12:30). A customer whose unloading takes longer than its receiving hours cannot be planned.',
  },
};

/**
 * The rule in words, for the effective planner values, the plan's ASSUMPTIONS sheet and the guide.
 * null: a plan made before the rule was echoed (unloading only had to start by closing).
 */
export function windowRuleText(rule: WindowRule | null | undefined): string {
  if (rule === 'FINISH') return 'unloading must be finished by the end of the receiving hours';
  if (rule === 'START') return 'the end of the receiving hours is the latest arrival: unloading must start by then and may continue after it';
  return 'earlier rule: unloading had to start by closing and could run past it';
}

/** The preferred window under the rule (soft): what costs after the preferred end. */
export function preferredEndText(rule: WindowRule): string {
  return rule === 'FINISH' ? 'finishes after the preferred end' : 'starts after the preferred end';
}

/** The minutes past closing a FINISH-rule unloading may end (feasibility.ts TOL_MIN: the solver rounds to the minute). */
export const FINISH_TOL_MIN = 1;

/**
 * A stop's planned unloading misses the hard window [start, end] (null = open on that side) by the rule
 * its load was planned with - exactly as the timetable check reads it (feasibility.ts HARD_WINDOW, a spec
 * holds both to the same answers): unloading starting before the start or after the end is outside; under
 * FINISH unloading must also end by the end (+FINISH_TOL_MIN). START, or an older plan without the echo
 * (null): only the start counts. `startMin` null (not known): false - the caller says it cannot tell.
 */
export function hardWindowMiss(startMin: number | null, departureMin: number | null, start: number | null, end: number | null, rule: WindowRule | null | undefined): boolean {
  if (startMin === null) return false;
  if ((start !== null && startMin < start) || (end !== null && startMin > end)) return true;
  return rule === 'FINISH' && end !== null && departureMin !== null && departureMin > end + FINISH_TOL_MIN;
}

/** "Made by a planner without the rule ..." (plannerRulesNote): the rule that was asked for, in words. */
export function windowRuleAskedText(rule: WindowRule): string {
  return rule === 'FINISH' ? 'that unloading must be finished by closing' : 'that the end of the receiving hours is the latest arrival';
}
