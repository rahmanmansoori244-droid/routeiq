import { headers } from 'next/headers';
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { clientIpFromHeaders } from './client-ip';
import type { AuditAction, AuditEntity } from './audit-catalog';

/**
 * Audit actions and entities come from the one catalog (lib/audit-catalog.ts, review F23): a
 * writer cannot use a name the audit API and the Audit log page do not know.
 */
export type { AuditAction, AuditEntity } from './audit-catalog';

export interface AuditInput {
  tenantId: string;
  userId?: string | null;
  action: AuditAction;
  entity: AuditEntity;
  entityId?: string | null;
  beforeJson?: Prisma.InputJsonValue | null;
  afterJson?: Prisma.InputJsonValue | null;
  ip?: string | null;
}

/**
 * Keys that must never be stored in, or shown from, audit before/after JSON: credential hashes
 * and session tokens. Removed at any depth.
 */
export const AUDIT_REDACTED_KEYS: ReadonlySet<string> = new Set([
  'accessPinHash',
  'passwordHash',
  'sessionToken',
  'tokenHash',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A copy of `value` without the AUDIT_REDACTED_KEYS, at any depth (plain objects and arrays).
 * Other objects (Date, Decimal) are kept as they are.
 */
export function redactForAudit<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactForAudit(v)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (AUDIT_REDACTED_KEYS.has(k)) continue;
      out[k] = redactForAudit(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Writes an audit log entry. Pass `tx` to enroll the audit write in the same
 * transaction as the change it describes (preferred — see CLAUDE.md §16.9).
 * Credential hashes and tokens are stripped from before/after JSON (redactForAudit).
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
      beforeJson: input.beforeJson != null ? redactForAudit(input.beforeJson) : undefined,
      afterJson: input.afterJson != null ? redactForAudit(input.afterJson) : undefined,
      ip: ip ?? undefined,
    },
  });
}

function getRequestIp(): string | null {
  try {
    return clientIpFromHeaders(headers());
  } catch {
    return null;
  }
}
