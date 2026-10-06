/**
 * Audit of 27 Sep 2026, F03 (owner decision 7): a depot that anything refers to - trucks,
 * regions, plans, orders, order files - is deactivated, never deleted; only a depot nothing
 * refers to is deleted. Before, the API counted trucks and plans only, so a depot with orders but
 * no trucks was deleted and its orders lost their depot (another depot's plan took them, or none
 * did), while the dialog promised "deactivated" for a depot with regions and the API deleted it.
 * The API counts under a row lock, answers a database refusal (NO ACTION keys) by deactivating,
 * and the dialog uses the same rule and words.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  DEPOT_REF_COUNT,
  depotDeleteActionLabel,
  depotDeleteDialogText,
  depotDeletedToast,
  depotDeleteOutcome,
  depotReferenceText,
  driverDeactivatedWarning,
} from '@/lib/master-data-delete';

const S = vi.hoisted(() => ({
  counts: { trucks: 0, regions: 0, runs: 0, orders: 0, uploadBatches: 0 } as Record<string, number>,
  active: true,
  exists: true,
  deleteFails: false,
  calls: [] as string[],
  queries: [] as string[],
  audits: [] as Record<string, any>[],
}));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'TENANT_ADMIN', name: 'A', email: 'a@a.example' } })) }));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    depot: {
      findUnique: vi.fn(async () => ({ id: 'd1', code: 'NZW', active: S.active, openMin: null, closeMin: null })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'd1', code: 'NZW', openMin: null, closeMin: null, ...data })),
    },
  }),
}));
vi.mock('@/lib/dispatch/open-orders', async (orig) => ({
  ...(await orig<typeof import('@/lib/dispatch/open-orders')>()),
  openOrders: vi.fn(async () => ({ orders: S.counts.orders, firstDate: S.counts.orders ? '2026-10-15' : null })),
}));
vi.mock('@/lib/db', () => {
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      S.queries.push(strings.join('?'));
      return S.exists ? [{ id: 'd1' }] : [];
    }),
    depot: {
      findUniqueOrThrow: vi.fn(async (args: { include?: { _count?: { select?: Record<string, boolean> } } }) => {
        S.calls.push(`count:${Object.keys(args.include?._count?.select ?? {}).sort().join(',')}`);
        return { id: 'd1', code: 'NZW', active: S.active, _count: { ...S.counts } };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        S.calls.push(`update:${JSON.stringify(data)}`);
        return { id: 'd1', code: 'NZW', ...data };
      }),
      delete: vi.fn(async () => {
        S.calls.push('delete');
        if (S.deleteFails) {
          S.deleteFails = false;
          S.counts.orders = 1; // committed by someone else; the database refuses the delete
          throw new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated: `Order_depotId_fkey (index)`', { code: 'P2003', clientVersion: '5' });
        }
        return {};
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        S.audits.push(data);
        return {};
      }),
    },
  };
  return { prisma: { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } };
});

import { DELETE, PATCH } from '@/app/api/depots/[id]/route';

const del = async () => {
  const res = await DELETE(new Request('http://localhost/api/depots/d1', { method: 'DELETE' }), { params: { id: 'd1' } });
  return { status: res.status, body: (await res.json()) as { data: any; error: any } };
};

beforeEach(() => {
  S.counts = { trucks: 0, regions: 0, runs: 0, orders: 0, uploadBatches: 0 };
  S.active = true;
  S.exists = true;
  S.deleteFails = false;
  S.calls = [];
  S.queries = [];
  S.audits = [];
});

describe('DELETE /api/depots/:id (audit F03)', () => {
  it('a depot with orders but no trucks or plans is deactivated, not deleted (its orders keep it)', async () => {
    S.counts.orders = 1;
    S.counts.uploadBatches = 2;
    const r = await del();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ softDeleted: true, depot: { active: false }, references: '1 order and 2 order files' });
    expect(r.body.data.warning).toContain('keep it and are not planned while it is inactive');
    expect(S.calls).not.toContain('delete');
    expect(S.calls).toContain('update:{"active":false}');
    expect(S.audits[0]).toMatchObject({ action: 'UPDATE', entity: 'Depot', afterJson: { softDeleted: true, references: { orders: 1, uploadBatches: 2 } } });
  });

  it('counts every reference (trucks, regions, plans, orders, order files) under a row lock', async () => {
    S.counts.regions = 1; // the old API deleted a depot with only a region, while its dialog said "deactivated"
    const r = await del();
    expect(r.body.data.softDeleted).toBe(true);
    expect(S.calls[0]).toBe('count:hireOptions,orders,regions,runs,trucks,uploadBatches');
    expect(S.queries[0]).toMatch(/FROM "Depot" WHERE "id" = \? AND "tenantId" = \? FOR UPDATE/);
  });

  it('a depot nothing refers to is deleted', async () => {
    const r = await del();
    expect(r.body.data).toEqual({ deleted: true });
    expect(S.calls).toContain('delete');
    expect(S.audits[0]).toMatchObject({ action: 'DELETE', entity: 'Depot' });
  });

  it('when the database refuses the delete (a reference the count did not see), the depot is deactivated instead', async () => {
    S.deleteFails = true;
    const r = await del();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ softDeleted: true, depot: { active: false } });
    expect(S.calls.filter((c) => c === 'delete')).toHaveLength(1);
  });

  it('deactivating with the Active switch (PATCH) warns that its open orders wait for it', async () => {
    S.counts.orders = 3;
    const res = await PATCH(new Request('http://localhost/api/depots/d1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active: false }) }), { params: { id: 'd1' } });
    expect(res.status).toBe(200);
    expect((await res.json()).data.warning).toBe('3 open order(s) of this depot (from 2026-10-15) keep it and are not planned while it is inactive. Reactivate the depot to plan them.');
  });

  it('404 for a depot of another company (the lock query filters by tenant)', async () => {
    S.exists = false;
    expect((await del()).status).toBe(404);
    expect(S.calls).toEqual([]);
  });
});

describe('the rule and its words, shared by the dialog and the API', () => {
  it('any reference means deactivate', () => {
    expect(DEPOT_REF_COUNT).toEqual({ trucks: true, regions: true, runs: true, orders: true, uploadBatches: true, hireOptions: true });
    expect(depotDeleteOutcome({ trucks: 0 })).toBe('DELETE');
    for (const k of ['trucks', 'regions', 'runs', 'orders', 'uploadBatches', 'hireOptions'] as const) {
      expect(depotDeleteOutcome({ trucks: 0, [k]: 1 }), k).toBe('DEACTIVATE');
    }
  });

  it('a depot with only trucks to hire (the hire suggestion) is deactivated, and the dialog and the toast say why (review)', () => {
    expect(depotReferenceText({ trucks: 0, hireOptions: 1 })).toBe('1 truck to hire');
    expect(depotReferenceText({ trucks: 1, hireOptions: 2 })).toBe('1 truck and 2 trucks to hire');
    expect(depotDeleteDialogText('D2', { trucks: 0, hireOptions: 1 })).toMatch(/^Depot D2 has 1 truck to hire, so it will be deactivated, not deleted/);
    expect(depotDeleteDialogText('D2', null)).toMatch(/trucks, trucks to hire, regions, plans, orders or order files/);
  });

  it('the dialog says what will happen', () => {
    expect(depotReferenceText({ trucks: 2, regions: 1, orders: 120 })).toBe('2 trucks, 1 region and 120 orders');
    expect(depotDeleteDialogText('NZW', { trucks: 0, orders: 1 })).toBe(
      'Depot NZW has 1 order, so it will be deactivated, not deleted: they keep their depot, and it is no longer offered for new order files and plans. Reactivate it any time with Edit.',
    );
    expect(depotDeleteDialogText('NZW', { trucks: 0 })).toBe('Nothing refers to depot NZW yet, so it will be deleted. This cannot be undone.');
    expect(depotDeleteDialogText('NZW', null)).toMatch(/deactivated, not deleted, if anything refers to it/);
    expect([depotDeleteActionLabel({ trucks: 0 }), depotDeleteActionLabel({ trucks: 0, runs: 3 }), depotDeleteActionLabel(null)]).toEqual(['Delete', 'Deactivate', 'Delete / deactivate']);
    expect(depotDeletedToast('NZW', { softDeleted: true, references: '1 order' })).toBe('Depot NZW deactivated (it has 1 order). Reactivate it any time with Edit.');
    expect(depotDeletedToast('NZW', { softDeleted: false })).toBe('Depot NZW deleted.');
  });

  it('the Depots page counts every reference and its dialog uses these words', () => {
    const page = readFileSync(path.join(__dirname, '../../app/t/[slug]/depots/page.tsx'), 'utf8');
    const table = readFileSync(path.join(__dirname, '../../app/t/[slug]/depots/depots-table.tsx'), 'utf8');
    expect(page).toMatch(/_count: \{ select: DEPOT_REF_COUNT \}/);
    expect(table).toMatch(/depotDeleteDialogText\(confirming\.code, refsOf\(confirming\)\)/);
    expect(table).not.toMatch(/deactivated rather than hard-deleted/);
  });

  it('driver deactivation names the trucks that keep the driver as default (audit F20)', () => {
    expect(driverDeactivatedWarning([])).toBeNull();
    expect(driverDeactivatedWarning(['T1'])).toMatch(/^This driver is still the default driver of truck T1\. New plans do not use an inactive driver/);
  });
});

/**
 * The screens say what the API does (review of audit PR 3). The API always deactivates a driver
 * and sends a `warning` when a driver or a depot is switched off; without these checks the
 * Drivers dialog could promise a delete again ("that cannot be undone"), its toast could say
 * "deleted" or "deactivated instead of deleted", and the Edit forms could drop the warning, with
 * every other check still green.
 */
describe('the Drivers and Depots screens say what the API does (audit F20 / F03)', () => {
  const screen = (file: string) => readFileSync(path.join(__dirname, '../../app/t/[slug]', file), 'utf8');

  it('the Drivers screen only deactivates: its button, dialog and toast never speak of deleting', () => {
    const table = screen('drivers/drivers-table.tsx');
    expect(table).toMatch(/aria-label="Deactivate"/);
    expect(table).toMatch(/Deactivate driver \{confirming\?\.code\}\?/);
    expect(table).toMatch(/Drivers are never deleted/);
    expect(table).toMatch(/toast\.success\(`Driver \$\{d\.code\} deactivated\.`\)/);
    expect(table).not.toMatch(/aria-label="Delete"/);
    expect(table).not.toMatch(/is deleted; that cannot be undone/);
    expect(table).not.toMatch(/deactivated instead of deleted/);
    expect(table).not.toMatch(/\} deleted\.`/);
  });

  it("the Drivers Deactivate and both Edit forms show the answer's warning (trucks that keep the driver, open orders of the depot)", () => {
    const WARNING_TOAST = /typeof (\w+)\?\.data\?\.warning === 'string'\) toast\.warning\(\1\.data\.warning/;
    for (const file of ['drivers/drivers-table.tsx', 'drivers/driver-form.tsx', 'depots/depot-form.tsx']) {
      expect(screen(file), file).toMatch(WARNING_TOAST);
    }
  });
});
