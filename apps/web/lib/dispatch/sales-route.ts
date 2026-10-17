/**
 * The salesman's route of an invoice line (owner request 17 Oct 2026, "Salesman ETA"): the order file's
 * "route" column (order-headers.ts, field `sales_route`), kept per order line as OrderLine.salesRoute.
 * The owner prints, every evening after planning, one page per sales route listing that salesman's
 * customers of the next day with the expected arrival window (lib/exports/salesman-eta.ts), so the
 * salesmen can tell their customers. Before, an offline tool did it from the same file.
 *
 * The route is a label only: it is never part of a duplicate or intake key (lineDupKey, IntakeLineKey,
 * contentFingerprint), never changes how an order is planned, and a line without one is simply listed
 * under "Route not given". No dependencies, so the intake, the copies and the export share one rule.
 */

/** The most characters a stored route code keeps (the rest is cut off). */
export const SALES_ROUTE_MAX = 40;

/** The section and summary row of the lines whose order file gave no route. */
export const NO_SALES_ROUTE = 'Route not given';

/**
 * A route code as it is stored: spaces at the ends cut, every run of white space inside one space,
 * upper-case, at most SALES_ROUTE_MAX characters (whole characters, never half of one); empty = null.
 * " r2x " and "R2X" are one route; "R 10" stays "R 10" (a space that is really there counts).
 */
export function normSalesRoute(raw: string | null | undefined): string | null {
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  if (!s) return null;
  const cut = Array.from(s).slice(0, SALES_ROUTE_MAX).join('').trim();
  return cut || null;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Route codes in natural order: R1, R2, R10, R11X (numbers inside a code compare as numbers, not
 * letter by letter); null (no route) last. Codes the collator finds equal are ordered by their plain
 * characters, so the order never depends on the input order.
 */
export function compareSalesRoutes(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}
