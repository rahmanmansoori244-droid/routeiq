/**
 * Review F13: credential hashes and tokens never enter the audit log (redacted on write) and
 * never leave it (redacted on read, for rows written before this release).
 */
import { describe, expect, it, vi } from 'vitest';
import { AUDIT_REDACTED_KEYS, audit, redactForAudit } from '@/lib/audit';

describe('redactForAudit', () => {
  it('drops the secret keys at any depth, in objects and arrays', () => {
    const input = {
      code: 'D1',
      accessPinHash: '$2a$12$pin',
      nested: { passwordHash: '$2a$12$pw', keep: 1, deeper: [{ sessionToken: 'tok', name: 'x' }] },
      list: [{ tokenHash: 'abc', id: 'r1' }, 'plain', 3, null],
    };
    expect(redactForAudit(input)).toEqual({
      code: 'D1',
      nested: { keep: 1, deeper: [{ name: 'x' }] },
      list: [{ id: 'r1' }, 'plain', 3, null],
    });
    // The input is not mutated.
    expect(input.accessPinHash).toBe('$2a$12$pin');
  });

  it('keeps scalars, null and Date values as they are', () => {
    const d = new Date('2026-09-25T00:00:00Z');
    expect(redactForAudit(null)).toBeNull();
    expect(redactForAudit('x')).toBe('x');
    expect(redactForAudit({ createdAt: d }).createdAt).toBe(d);
  });

  it('covers exactly the credential fields', () => {
    expect([...AUDIT_REDACTED_KEYS].sort()).toEqual(['accessPinHash', 'passwordHash', 'sessionToken', 'tokenHash']);
  });

  it('audit() strips them before the row is written', async () => {
    const create = vi.fn(async (args: unknown) => args);
    const tx = { auditLog: { create } } as never;
    await audit(
      {
        tenantId: 't1',
        action: 'UPDATE',
        entity: 'Driver',
        entityId: 'd1',
        beforeJson: { code: 'D1', accessPinHash: '$2a$12$old' },
        afterJson: { code: 'D1', accessPinHash: '$2a$12$new', name: 'N' },
        ip: '203.0.113.1',
      },
      tx,
    );
    const data = (create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.beforeJson).toEqual({ code: 'D1' });
    expect(data.afterJson).toEqual({ code: 'D1', name: 'N' });
    expect(JSON.stringify(data)).not.toMatch(/\$2[aby]\$\d\d\$/);
  });
});
