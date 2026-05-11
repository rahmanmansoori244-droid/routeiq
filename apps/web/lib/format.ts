import type { CapacityUnit } from '@prisma/client';

const UNIT_LABELS: Record<CapacityUnit, { short: string; long: string }> = {
  CASES: { short: 'cs', long: 'cases' },
  CARTONS: { short: 'ctn', long: 'cartons' },
  PALLETS: { short: 'plt', long: 'pallets' },
  KG: { short: 'kg', long: 'kilograms' },
};

export function unitShort(u: CapacityUnit) {
  return UNIT_LABELS[u].short;
}
export function unitLong(u: CapacityUnit) {
  return UNIT_LABELS[u].long;
}

export function fmtCapacity(value: number, unit: CapacityUnit): string {
  return `${value.toLocaleString()} ${UNIT_LABELS[unit].short}`;
}

export function fmtMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/**
 * Distance label — when Haversine is the provider, every km display says
 * "Estimated km" (see CLAUDE.md §7). Use this helper everywhere distance is shown.
 */
export function fmtKm(value: number | null | undefined, isEstimated: boolean): string {
  if (value === null || value === undefined) return '—';
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${isEstimated ? 'est. km' : 'km'}`;
}

export function kmLabel(isEstimated: boolean): string {
  return isEstimated ? 'Estimated km' : 'Km';
}
