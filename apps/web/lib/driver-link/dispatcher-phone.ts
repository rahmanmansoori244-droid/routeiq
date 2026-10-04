/**
 * The number behind the driver page's "Call dispatcher" button (owner decision 3, 5 Oct 2026: ONE
 * NUMBER PER DEPOT). Pure; the manifest (manifest.ts) reads the depots and the company setting.
 *
 * The depot is the one of the truck-day's loads: of the trip the driver is on or goes on next (the
 * first load in departure order that is not COMPLETED), else of the last trip. That depot's own
 * number (Depot.dispatcherPhone, set by a company admin on the Depots page); a depot without one
 * falls back to the company number (TenantConfig.dispatcherPhone, Settings), never to another
 * depot's. No number at all: null, and the page hides the button.
 */
export function dispatcherPhoneFor(
  loads: readonly { depotId: string; status: string }[],
  depotPhones: ReadonlyMap<string, string | null>,
  companyPhone: string | null,
): string | null {
  const clean = (p: string | null | undefined) => p?.trim() || null;
  const current = loads.find((l) => l.status !== 'COMPLETED') ?? loads.at(-1);
  const own = current ? clean(depotPhones.get(current.depotId)) : null;
  return own ?? clean(companyPhone);
}
