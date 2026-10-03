/**
 * Small pure helpers of the driver page (owner request 4 Oct 2026): what the page shows of a trip
 * and a stop. Browser-safe; the words come from i18n.ts.
 */
import type { DriverManifest, ManifestLoad, ManifestStop } from '../driver-link/manifest-types';
import { hhmm, t, type Lang } from './i18n';

/** "Trip 1 of 2 · Depart 07:10 · Stops: 9 · Cases: 412" */
export function tripLine(lang: Lang, l: ManifestLoad): string {
  return [
    t(lang, 'tripOf', { n: l.loadNo, m: Math.max(l.trips, l.loadNo) }),
    t(lang, 'depart', { time: hhmm(l.departMin) }),
    t(lang, 'stopsLabel', { n: l.stops.length }),
    t(lang, 'casesLabel', { n: l.cases }),
  ].join(' · ');
}

/** "ACME (C001/B1)" */
export function stopTitle(s: Pick<ManifestStop, 'customerName' | 'customerCode' | 'branchCode'>): string {
  return `${s.customerName} (${s.customerCode}${s.branchCode ? `/${s.branchCode}` : ''})`;
}

/**
 * The trip to open first: the first load that is on the road, else the first that is not done, else
 * the first. Index into manifest.loads, or -1 without loads.
 */
export function openTripIndex(m: Pick<DriverManifest, 'loads'>): number {
  if (!m.loads.length) return -1;
  const onRoad = m.loads.findIndex((l) => l.status === 'DISPATCHED');
  if (onRoad >= 0) return onRoad;
  const open = m.loads.findIndex((l) => l.status !== 'COMPLETED');
  return open >= 0 ? open : 0;
}

/** A tel: link for the dispatcher's number (digits and a leading +), or null without one. */
export function telHref(phone: string | null | undefined): string | null {
  const raw = (phone ?? '').trim();
  const digits = raw.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  return digits.replace(/\+/g, '').length >= 4 ? `tel:${digits}` : null;
}

/** The distinct names of the truck-day's drivers, "Salim, Khalid", or null without one. */
export function driverNames(m: Pick<DriverManifest, 'drivers'>): string | null {
  const names = m.drivers.map((d) => d.name).filter(Boolean);
  return names.length ? names.join(', ') : null;
}
