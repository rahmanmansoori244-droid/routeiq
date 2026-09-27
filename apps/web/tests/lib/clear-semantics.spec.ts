/**
 * Audit of 27 Sep 2026, F26 (owner decision 10): in a save, a field left out stays as it is and an
 * empty (or null) value clears it. Before, clearing a driver's phone said "saved" and kept the
 * old number (WhatsApp links kept using it), "No depot" on a region failed ("Referenced record
 * does not exist"), and a region could not be created without a depot from the screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearable, customerPatchSchema, customerSchema, depotPatchSchema, driverSchema, regionSchema, truckPatchSchema } from '@/lib/schemas';
import { z } from 'zod';

const S = vi.hoisted(() => ({ creates: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[], depotLookups: 0 }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'TENANT_ADMIN', name: 'A', email: 'a@a.example' } })) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => ({})) }));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    depot: {
      findUnique: async () => {
        S.depotLookups++;
        return { id: 'd1' };
      },
    },
    region: {
      findUnique: async () => ({ id: 'r1', code: 'R1', name: 'Ghala', depotId: 'd1' }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        S.creates.push(data);
        return { id: 'r2', ...data };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        S.updates.push(data);
        return { id: 'r1', ...data };
      },
    },
  }),
}));

import { POST as createRegion } from '@/app/api/regions/route';
import { PATCH as patchRegion } from '@/app/api/regions/[id]/route';

const jreq = (url: string, method: string, body: unknown) => new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  S.creates = [];
  S.updates = [];
  S.depotLookups = 0;
});

describe('clearable fields (audit F26)', () => {
  it("left out = undefined (unchanged); '' / spaces / null = null (cleared); a value is checked", () => {
    const s = z.object({ x: clearable(z.string().trim().max(3)) });
    expect(s.parse({})).toEqual({});
    expect(s.parse({ x: '' })).toEqual({ x: null });
    expect(s.parse({ x: '   ' })).toEqual({ x: null });
    expect(s.parse({ x: null })).toEqual({ x: null });
    expect(s.parse({ x: ' ab ' })).toEqual({ x: 'ab' });
    expect(s.safeParse({ x: 'abcd' }).success).toBe(false);
  });

  it("driver phone: the form's emptied box clears it; left out keeps it; a bad number is still refused", () => {
    const patch = driverSchema.partial();
    expect(patch.parse({ code: 'D1', name: 'N', phone: '', active: true })).toEqual({ code: 'D1', name: 'N', phone: null, active: true });
    expect(patch.parse({ phone: null })).toEqual({ phone: null });
    expect(patch.parse({ name: 'N' })).not.toHaveProperty('phone');
    expect(patch.safeParse({ phone: 'call me' }).success).toBe(false);
    expect(driverSchema.parse({ code: 'D1', name: 'N', phone: '' }).phone).toBeNull();
  });

  it('region depot: none on a create and a clear on an edit', () => {
    expect(regionSchema.parse({ code: 'R1', name: 'R', depotId: '' }).depotId).toBeNull();
    expect(regionSchema.parse({ code: 'R1', name: 'R', depotId: null }).depotId).toBeNull();
    expect(regionSchema.parse({ code: 'R1', name: 'R' })).not.toHaveProperty('depotId');
    expect(regionSchema.partial().parse({ name: 'R' })).not.toHaveProperty('depotId');
  });

  it('customer, depot and truck optional texts follow the same rule', () => {
    expect(customerPatchSchema.parse({ accessNotes: '', address: null, regionId: '', branchCode: '' })).toEqual({ accessNotes: null, address: null, regionId: null, branchCode: null });
    expect(customerPatchSchema.parse({ priority: 2 })).toEqual({ priority: 2 });
    expect(customerSchema.parse({ code: 'C1', name: 'C', regionId: '' }).regionId).toBeNull();
    expect(depotPatchSchema.parse({ address: '' })).toEqual({ address: null });
    expect(truckPatchSchema.parse({ description: '' })).toEqual({ description: null });
    expect(truckPatchSchema.parse({ kmPerLitre: 5 })).not.toHaveProperty('description');
  });
});

describe('region routes (audit F26)', () => {
  it('a region is created without a depot, as the form sends it ("No depot" = null, or an old form\'s "")', async () => {
    for (const depotId of [null, '']) {
      const res = await createRegion(jreq('/api/regions', 'POST', { code: 'R2', name: 'Seeb', depotId }));
      expect(res.status).toBe(201);
    }
    expect(S.creates.map((c) => c.depotId)).toEqual([null, null]);
    expect(S.depotLookups).toBe(0);
  });

  it("an edit to 'No depot' clears the region's depot; an edit that leaves it out keeps it", async () => {
    expect((await patchRegion(jreq('/api/regions/r1', 'PATCH', { code: 'R1', name: 'Ghala', depotId: null }), { params: { id: 'r1' } })).status).toBe(200);
    expect((await patchRegion(jreq('/api/regions/r1', 'PATCH', { name: 'Ghala 2' }), { params: { id: 'r1' } })).status).toBe(200);
    expect(S.updates).toEqual([{ code: 'R1', name: 'Ghala', depotId: null }, { name: 'Ghala 2' }]);
  });

  it('the region form sends null for "No depot"', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(path.join(__dirname, '../../app/t/[slug]/regions/region-form.tsx'), 'utf8');
    expect(src).toMatch(/depotId: form\.depotId === NONE \? null : form\.depotId/);
  });
});
