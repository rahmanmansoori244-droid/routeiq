import { headers } from 'next/headers';
import { Prisma } from '@prisma/client';
import { prisma } from './db';

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'OVERRIDE'
  | 'DISPATCH'
  | 'LOGIN'
  | 'SIGNUP'
  | 'LOGOUT'
  | 'OPTIMIZE_STARTED'
  | 'OPTIMIZE_SUCCEEDED'
  | 'OPTIMIZE_FAILED'
  | 'SCENARIO_CHOSEN'
  | 'BASELINE_UPLOADED'
  | 'ROUTE_MANUALLY_CHANGED'
  | 'DRIVER_LOGIN'
  | 'DELIVERY_PROOF_CREATED'
  // NMWC dispatch MVP
  | 'CUSTOMER_LOCATION_SET'
  | 'LATE_ORDER_RECORDED'
  | 'PLAN_VERSION_CREATED'
  | 'LOAD_LOCKED'
  | 'LOAD_PLANNED'
  | 'LOAD_LOADING'
  | 'LOAD_DISPATCHED'
  | 'LOAD_COMPLETED';

export interface AuditInput {
  tenantId: string;
  userId?: string | null;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  beforeJson?: Prisma.InputJsonValue | null;
  afterJson?: Prisma.InputJsonValue | null;
  ip?: string | null;
}

/**
 * Writes an audit log entry. Pass `tx` to enroll the audit write in the same
 * transaction as the change it describes (preferred — see CLAUDE.md §16.9).
 */
export async function audit(input: AuditInput, tx?: Prisma.TransactionClient) {
  const client = tx ?? prisma;
  const ip = input.ip ?? getRequestIp();
  return client.auditLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId ?? undefined,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? undefined,
      beforeJson: input.beforeJson ?? undefined,
      afterJson: input.afterJson ?? undefined,
      ip: ip ?? undefined,
    },
  });
}

function getRequestIp(): string | null {
  try {
    const h = headers();
    const xff = h.get('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
    return h.get('x-real-ip');
  } catch {
    return null;
  }
}
