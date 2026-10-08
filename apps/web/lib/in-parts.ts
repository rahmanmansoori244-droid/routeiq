/**
 * PostgreSQL takes at most 32,767 bind parameters in one query, and Prisma does not split an `in`
 * list that comes with other conditions (it fails with P2035 or P2029). An order file may hold
 * 50,000 rows, and the delivery actuals of every depot for a month hold more stops than that, so a
 * list that grows with the data is asked for in parts of this many values (third review of audit
 * P5: a file of 32,766 or more sales orders was refused with Prisma's text; review of 8 Oct 2026:
 * the actuals Excel of a month of every depot answered 500).
 */
export const IN_LIST_PART = 10_000;

/** `values` in order, in parts of at most `size` (see IN_LIST_PART). */
export function inParts<T>(values: readonly T[], size = IN_LIST_PART): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < values.length; i += size) parts.push(values.slice(i, i + size));
  return parts;
}

/**
 * Every row `query` finds for the parts of `values` (see IN_LIST_PART), one part after the other,
 * the rows of each part in its own order. No query when `values` is empty.
 */
export async function findInParts<T, R>(values: readonly T[], query: (part: T[]) => Promise<R[]>): Promise<R[]> {
  let rows: R[] = [];
  for (const part of inParts(values)) rows = rows.concat(await query(part));
  return rows;
}
