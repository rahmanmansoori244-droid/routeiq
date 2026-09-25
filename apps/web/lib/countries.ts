/**
 * The company countries RouteIQ offers (Settings and sign-up pick from this list; review F21).
 * The country decides road routing: the shared road map covers Oman and the UAE only, so a company
 * elsewhere plans on straight-line estimates unless it has its own routing server - which is why
 * the country is no longer free text a typo could silently switch.
 *
 * Pure: shared by the server and the browser.
 */
import { isOmanUae } from './dispatch/customer-attrs';

export const COUNTRY_NAMES = ['Oman', 'United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Bahrain', 'Kuwait', 'Other'] as const;
export type CountryName = (typeof COUNTRY_NAMES)[number];

/** What the country means for planning, shown next to the pick-list. */
export function countryRoutingNote(country: string): string {
  return isOmanUae(country)
    ? 'Road distances from the Oman + UAE road map.'
    : 'Outside the Oman + UAE road map: plans use straight-line distance estimates (labelled Estimated km), and customer pins are not checked against a service area.';
}

/** A stored country that is not on the list (entered as free text before the list existed). */
export function isListedCountry(country: string | null | undefined): country is CountryName {
  return (COUNTRY_NAMES as readonly string[]).includes((country ?? '').trim());
}
