/**
 * The IVMS live link's company settings (TenantConfig.ivms*, 16 Oct 2026): bounds, defaults and the mode
 * order. Company admin only (never a dispatcher field: lib/settings-fields.ts). Pure and browser-safe:
 * shared by the API schema (lib/schemas.ts), the Settings page and the IVMS server code.
 *
 * The bounds are the database CHECKs of migration 20261016200000_ivms_live, value for value
 * (tests/lib/ivms-contract.spec.ts reads the migration and compares).
 */
import { IVMS_MODES, type IvmsMode } from './types';

export const IVMS_SETTING_BOUNDS = {
  ivmsPollSec: { min: 30, max: 900 },
  ivmsRoutePullMin: { min: 30, max: 240 },
  ivmsFromMin: { min: 0, max: 1439 },
  ivmsToMin: { min: 1, max: 1440 },
  ivmsDailyCallBudget: { min: 10, max: 100_000 },
  ivmsStopRadiusM: { min: 50, max: 300 },
  ivmsStopDwellMin: { min: 1, max: 30 },
  ivmsDepotRadiusM: { min: 100, max: 2000 },
  ivmsTrailDays: { min: 1, max: 7 },
} as const;
export type IvmsNumberSetting = keyof typeof IVMS_SETTING_BOUNDS;

/**
 * The defaults (the schema's, and what a company gets at the migration). Pending owner decisions, all
 * settings: mode OFF; positions every 60 s when the allowance allows; history every 60 min while a load
 * is out; operating hours 05:00-23:00; today's allowance of 100 calls a day; trail kept 2 days.
 */
export const IVMS_SETTING_DEFAULTS = {
  ivmsMode: 'OFF',
  ivmsPollSec: 60,
  ivmsRoutePullMin: 60,
  ivmsFromMin: 300,
  ivmsToMin: 1380,
  ivmsDailyCallBudget: 100,
  ivmsStopRadiusM: 100,
  ivmsStopDwellMin: 3,
  ivmsDepotRadiusM: 300,
  ivmsTrailDays: 2,
} as const satisfies { ivmsMode: IvmsMode } & Record<IvmsNumberSetting, number>;

/** Every IVMS setting, in the order the Settings card shows them. */
export const IVMS_SETTINGS_FIELDS = [
  'ivmsMode',
  'ivmsPollSec',
  'ivmsRoutePullMin',
  'ivmsFromMin',
  'ivmsToMin',
  'ivmsDailyCallBudget',
  'ivmsStopRadiusM',
  'ivmsStopDwellMin',
  'ivmsDepotRadiusM',
  'ivmsTrailDays',
] as const satisfies readonly (keyof typeof IVMS_SETTING_DEFAULTS)[];
export type IvmsSettingsField = (typeof IVMS_SETTINGS_FIELDS)[number];

/** The mode a settings row asks for: one of IVMS_MODES, anything else (or no row) = OFF. */
export function ivmsModeOf(cfg: { ivmsMode?: string | null } | null | undefined): IvmsMode {
  const m = cfg?.ivmsMode;
  return (IVMS_MODES as readonly string[]).includes(m ?? '') ? (m as IvmsMode) : 'OFF';
}

/** Does `mode` include `wanted`? (The modes step up: OFF < MAP < TIMES.) */
export function ivmsModeAtLeast(mode: IvmsMode, wanted: IvmsMode): boolean {
  return IVMS_MODES.indexOf(mode) >= IVMS_MODES.indexOf(wanted);
}

/**
 * The operating hours as a save applies them (the settings route and the Settings form alike): the end
 * must be after the start (no hours across midnight; the database CHECK "TenantConfig_ivmsHours_order").
 * Only a save that changes one of them is held to it.
 */
export function ivmsHoursSaveProblem(changed: Record<string, unknown>, merged: { ivmsFromMin: number; ivmsToMin: number }): string | null {
  if (!('ivmsFromMin' in changed) && !('ivmsToMin' in changed)) return null;
  return merged.ivmsToMin > merged.ivmsFromMin
    ? null
    : `GPS tracking hours: the end (${merged.ivmsToMin} min) must be after the start (${merged.ivmsFromMin} min); hours across midnight are not supported.`;
}
