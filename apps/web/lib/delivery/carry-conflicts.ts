/**
 * A brought-forward order whose original result changed after the carry (owner request 4 Oct 2026,
 * spec section 9.4). Server only, read-only.
 *
 * A change that would shrink the cases brought forward is refused and kept as a CARRY_CONFLICT event
 * on the original's visit (payload: the refused result and the copy's id). The copy's day then warns:
 * a red chip on the copy's stop ("May not be needed: the 5 Oct result was changed after it was brought
 * forward") and a question at Lock ("ACME's brought-forward order may not be needed (the 5 Oct result
 * changed to Delivered). Lock anyway?"). It never refuses: a real shortfall is never held back.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { fmtDayMonth, isoOf } from '../dispatch/time';
import { OUTCOME_LABEL } from './office-text';

type Db = Prisma.TransactionClient | typeof prisma;

export interface CopyConflict {
  /** The copy (the order on the later day). */
  copyId: string;
  customerCode: string;
  /** The original's delivery date (YYYY-MM-DD). */
  fromDate: string;
  /** The refused result ("Delivered", "Partly delivered", "no result"). */
  refused: string;
  /** "May not be needed: the 5 Oct result was changed after it was brought forward (to Delivered)". */
  chip: string;
  /** The Lock question's line: "ACME's brought-forward order may not be needed (the 5 Oct result changed to Delivered)." */
  lockText: string;
}

/** The conflicts of these orders (the copies among them), newest refused change per copy. */
export async function copyConflicts(db: Db, tenantId: string, orderIds: readonly string[]): Promise<Map<string, CopyConflict>> {
  const out = new Map<string, CopyConflict>();
  if (!orderIds.length) return out;
  const copies = await db.order.findMany({
    where: { tenantId, id: { in: [...orderIds] }, carriedFromOrderId: { not: null } },
    select: { id: true, carriedFromOrderId: true, customer: { select: { code: true, branchCode: true } } },
  });
  if (!copies.length) return out;
  const originals = await db.order.findMany({ where: { tenantId, id: { in: copies.map((c) => c.carriedFromOrderId!) } }, select: { id: true, deliveryDate: true } });
  const dateOf = new Map(originals.map((o) => [o.id, isoOf(o.deliveryDate)]));
  const dates = [...new Set(originals.map((o) => o.deliveryDate.getTime()))].map((t) => new Date(t));
  if (!dates.length) return out;
  const events = await db.stopEvent.findMany({
    where: { tenantId, kind: 'CARRY_CONFLICT', deliveryDate: { in: dates } },
    select: { at: true, payloadJson: true },
    orderBy: [{ at: 'asc' }],
  });
  for (const c of copies) {
    const mine = events.filter((e) => (e.payloadJson as { copyId?: unknown } | null)?.copyId === c.id);
    const last = mine[mine.length - 1];
    if (!last) continue;
    const refusedOutcome = ((last.payloadJson as { refused?: { outcome?: unknown } } | null)?.refused?.outcome ?? null) as string | null;
    const refused = refusedOutcome ? (OUTCOME_LABEL[refusedOutcome] ?? refusedOutcome) : 'no result';
    const fromDate = dateOf.get(c.carriedFromOrderId!) ?? '';
    const day = fromDate ? fmtDayMonth(fromDate) : 'earlier';
    const who = c.customer.branchCode ? `${c.customer.code}/${c.customer.branchCode}` : c.customer.code;
    out.set(c.id, {
      copyId: c.id,
      customerCode: who,
      fromDate,
      refused,
      chip: `May not be needed: the ${day} result was changed after it was brought forward (to ${refused})`,
      lockText: `${who}'s brought-forward order may not be needed (the ${day} result changed to ${refused}).`,
    });
  }
  return out;
}

/** The Lock warnings of one load (its orders that are copies with a conflict). */
export async function lockWarningsOf(db: Db, tenantId: string, loadId: string): Promise<string[]> {
  const rows = await db.routeAssignment.findMany({ where: { loadId }, select: { orderId: true } });
  const found = await copyConflicts(db, tenantId, [...new Set(rows.map((r) => r.orderId))]);
  return [...found.values()].map((c) => c.lockText);
}
