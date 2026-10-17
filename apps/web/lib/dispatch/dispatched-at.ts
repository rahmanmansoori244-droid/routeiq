/**
 * When each load was marked Dispatched (moved here from crew-report.ts on 16 Oct 2026 unchanged, so the
 * Crew report and the IVMS live link's GPS trips (lib/ivms/stop-events.ts: trips are matched to loads in
 * dispatch order) read it one way). Reads only; every query names the company.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { findInParts } from '../in-parts';

type Db = Prisma.TransactionClient | typeof prisma;

/** A copied load points to the load it was copied from: at most this many versions are followed. */
const MAX_VERSIONS = 60;

/**
 * When each load was marked Dispatched: the LOAD_DISPATCHED audit row of the load, or of the load it
 * was copied from in an earlier plan version (a re-plan copies a dispatched load; the dispatch was
 * recorded on the original). The latest row of the nearest load in the chain wins.
 */
export async function dispatchedAt(db: Db, tenantId: string, loads: readonly { id: string; carriedFromLoadId: string | null }[]): Promise<Map<string, Date>> {
  const parent = new Map<string, string | null>(loads.map((l) => [l.id, l.carriedFromLoadId]));
  let frontier = [...new Set(loads.map((l) => l.carriedFromLoadId).filter((x): x is string => !!x && !parent.has(x)))];
  for (let i = 0; i < MAX_VERSIONS && frontier.length; i++) {
    const rows = await findInParts(frontier, (part) => db.planLoad.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, carriedFromLoadId: true } }));
    for (const r of rows) parent.set(r.id, r.carriedFromLoadId ?? null);
    for (const id of frontier) if (!parent.has(id)) parent.set(id, null);
    frontier = [...new Set(rows.map((r) => r.carriedFromLoadId).filter((x): x is string => !!x && !parent.has(x)))];
  }
  const audits = await findInParts([...parent.keys()], (part) =>
    db.auditLog.findMany({ where: { tenantId, action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: { in: part } }, select: { entityId: true, createdAt: true } }),
  );
  const latest = new Map<string, Date>();
  for (const a of audits) {
    if (!a.entityId) continue;
    const cur = latest.get(a.entityId);
    if (!cur || a.createdAt > cur) latest.set(a.entityId, a.createdAt);
  }
  const out = new Map<string, Date>();
  for (const l of loads) {
    let id: string | null = l.id;
    for (let i = 0; id && i <= MAX_VERSIONS; i++) {
      const at = latest.get(id);
      if (at) {
        out.set(l.id, at);
        break;
      }
      id = parent.get(id) ?? null;
    }
  }
  return out;
}
