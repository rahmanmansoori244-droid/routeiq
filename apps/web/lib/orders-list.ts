/**
 * The order lists outside the day screen: GET /api/orders and the Orders tab of the upload page.
 *
 * PR9 (bring forward): an order brought forward to a later day keeps its status on its own day
 * (UNSERVED, ASSIGNED, ...: the history of that day), and its copy is an open order of the day it
 * went to. So both lists carry the link (`carriedTo` on the original, `carriedFromDate` on the
 * copy) to show "Carried over to 28 Sep" / "Carried over from 27 Sep" (orderCarryMarks), and a
 * filter on an open status never returns a carried original: it is not open, unserved or pending
 * anywhere on its own day. `status=CARRIED` lists the carried originals.
 */
import type { OrderStatus, Prisma } from '@prisma/client';

/** What an order list row includes (the customer, its line count and the carry links). */
export const ORDER_LIST_INCLUDE = {
  customer: { select: { id: true, code: true, name: true, branchKey: true, region: { select: { id: true, code: true } } } },
  _count: { select: { lines: true } },
  carriedTo: { select: { deliveryDate: true } },
} satisfies Prisma.OrderInclude;

/** Statuses of an order that is still open on its day - unless it was brought forward. */
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = ['UPLOADED', 'VALIDATED', 'ASSIGNED', 'UNSERVED'];

/** Pseudo-status of the status filter: the orders brought forward to a later day. */
export const CARRIED_STATUS = 'CARRIED';

/**
 * The where-part of a status filter: an open status leaves out the orders brought forward to a later
 * day (they are open on that day, as their copy); CARRIED lists only those; any other status as is.
 */
export function orderStatusFilter(status: string): Prisma.OrderWhereInput {
  if (status === CARRIED_STATUS) return { carriedToOrderId: { not: null } };
  if ((OPEN_ORDER_STATUSES as readonly string[]).includes(status)) return { status: status as OrderStatus, carriedToOrderId: null };
  return { status: status as OrderStatus };
}
