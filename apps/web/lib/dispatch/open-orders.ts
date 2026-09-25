/**
 * Open confirmed orders of a customer or product from today on (not yet out for delivery), for
 * the warning shown when the master record is deactivated.
 */
import type { OrderStatus } from '@prisma/client';
import { prisma } from '../db';
import { dateOnly, isoOf, todayIso } from './time';

const OPEN: OrderStatus[] = ['UPLOADED', 'VALIDATED', 'ASSIGNED', 'UNSERVED'];

export async function openOrders(tenantId: string, of: { customerId: string } | { productId: string }): Promise<{ orders: number; firstDate: string | null }> {
  const cfg = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { timezone: true } });
  const from = dateOnly(todayIso(cfg?.timezone ?? 'Asia/Muscat'));
  const where = {
    tenantId,
    status: { in: OPEN },
    deliveryDate: { gte: from },
    ...('customerId' in of ? { customerId: of.customerId } : { lines: { some: { productId: of.productId } } }),
  };
  const [orders, first] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findFirst({ where, orderBy: { deliveryDate: 'asc' }, select: { deliveryDate: true } }),
  ]);
  return { orders, firstDate: first ? isoOf(first.deliveryDate) : null };
}

/** The warning text, or null when nothing is open. */
export function deactivateWarning(kind: 'customer' | 'product', open: { orders: number; firstDate: string | null }): string | null {
  if (!open.orders) return null;
  return kind === 'customer'
    ? `${open.orders} open order(s) of this customer (from ${open.firstDate}) will be left unserved at the next optimize or re-plan. Reactivate the customer to deliver them.`
    : `${open.orders} open order(s) (from ${open.firstDate}) still contain this product. They are delivered as ordered; new files with it will be refused.`;
}
