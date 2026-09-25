/**
 * Review F10 / new issue: a platform admin (SUPER_ADMIN) opening another tenant's pages leaves a
 * CROSS_TENANT_VIEW row in THAT tenant's audit log, at most once per admin, tenant and hour.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.fn(async () => ({}));
vi.mock('@/lib/audit', () => ({ audit }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const { recordCrossTenantView, CROSS_TENANT_VIEW_EVERY_MS } = await import('@/lib/tenant');

beforeEach(() => audit.mockClear());

describe('recordCrossTenantView', () => {
  it('writes one row in the viewed tenant, then stays quiet for an hour', async () => {
    const t0 = 2_000_000_000_000;
    expect(await recordCrossTenantView('admin-1', 'ops@routeiq.example', 'tenant-X', 'nmwc', t0)).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-X', userId: 'admin-1', action: 'CROSS_TENANT_VIEW', entity: 'Tenant', entityId: 'tenant-X' }),
    );
    expect(await recordCrossTenantView('admin-1', 'ops@routeiq.example', 'tenant-X', 'nmwc', t0 + 60_000)).toBe(false);
    expect(await recordCrossTenantView('admin-1', 'ops@routeiq.example', 'tenant-Y', 'other', t0 + 60_000)).toBe(true);
    expect(await recordCrossTenantView('admin-1', 'ops@routeiq.example', 'tenant-X', 'nmwc', t0 + CROSS_TENANT_VIEW_EVERY_MS)).toBe(true);
    expect(audit).toHaveBeenCalledTimes(3);
  });

  it('never breaks the page when the audit write fails', async () => {
    audit.mockRejectedValueOnce(new Error('db down'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordCrossTenantView('admin-2', 'a@b.c', 'tenant-Z', 'z', 3_000_000_000_000)).resolves.toBe(false);
    quiet.mockRestore();
  });
});
