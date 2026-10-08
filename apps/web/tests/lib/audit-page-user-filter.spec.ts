/**
 * The Audit log page's user filter (review db-schema-2). It lists the 25 users with the most audit
 * rows, most rows first. The names came from `auditLog.findMany({ distinct: ['userId'], include:
 * { user } })`, which Prisma 5 does in memory (no nativeDistinct): the SQL had no DISTINCT and no
 * LIMIT, so every visit read every audit row those users ever wrote, JSON included (17 s for 6 users
 * at 500,000 rows; +870 MB in the web process at 250,000). Now every audit read of the page is
 * bounded - the newest 200 rows and the 25 per-user counts - and the names are read from the users
 * table for the counted ids only. The list shows the same users as before.
 * Synthetic data only; the page runs on a recording fake database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { elements } from './hook-host';

type Args = Record<string, any>;

const S = vi.hoisted(() => {
  const users = [
    { id: 'u1', name: 'Dispatcher One', email: 'one@a.example' },
    { id: 'u2', name: 'Dispatcher Two', email: 'two@a.example' },
    { id: 'u3', name: 'Admin Three', email: 'three@a.example' },
    // A platform admin of no company who opened this company's pages (CROSS_TENANT_VIEW rows).
    { id: 'uP', name: 'Platform Admin', email: 'platform@routeiq.example' },
    // A user of another company with no audit row here.
    { id: 'uB', name: 'Other Company', email: 'b@b.example' },
  ];
  const state = {
    users,
    calls: [] as { model: string; op: string; args: Args }[],
    counts: [] as { userId: string | null; _count: { userId: number } }[],
  };
  const row = (id: string, userId: string | null) => ({
    id,
    tenantId: 'tA',
    userId,
    action: 'UPDATE',
    entity: 'Customer',
    entityId: 'c1',
    beforeJson: { name: 'Old' },
    afterJson: { name: 'New' },
    ip: null,
    createdAt: new Date('2026-10-08T06:00:00Z'),
    user: users.find((u) => u.id === userId) ?? null,
  });
  const db = {
    auditLog: {
      async findMany(args: Args) {
        state.calls.push({ model: 'auditLog', op: 'findMany', args });
        // The rows the old `distinct` query got back: one per user (Prisma removed the rest in memory).
        if (args.distinct) return (args.where.userId.in as string[]).map((u, i) => row(`d${i}`, u));
        return [row('a1', 'u1'), row('a2', null)];
      },
      async groupBy(args: Args) {
        state.calls.push({ model: 'auditLog', op: 'groupBy', args });
        return state.counts;
      },
    },
    user: {
      async findMany(args: Args) {
        state.calls.push({ model: 'user', op: 'findMany', args });
        const ids: string[] = args.where.id.in;
        // The database answers in its own order, not in the order of the ids.
        return users.filter((u) => ids.includes(u.id)).reverse().map((u) => ({ ...u, passwordHash: 'never selected' }));
      },
    },
  };
  return { state, db };
});

vi.mock('@/lib/tenant', () => ({
  getCurrentTenant: async () => ({ tenant: { id: 'tA', slug: 'a' }, user: { id: 'u3', role: 'TENANT_ADMIN', tenantId: 'tA' }, db: S.db }),
}));

import AuditPage from '@/app/t/[slug]/audit/page';
import { AuditClient } from '@/app/t/[slug]/audit/audit-client';

const count = (userId: string | null, n: number) => ({ userId, _count: { userId: n } });

async function shown() {
  const tree = await AuditPage({ params: { slug: 'a' } });
  const client = elements(tree).find((e) => e.type === AuditClient);
  expect(client, 'the page renders the audit list').toBeDefined();
  return client!.props as { users: { id: string; name: string; email: string }[]; initial: { id: string }[] };
}

beforeEach(() => {
  S.state.calls = [];
  S.state.counts = [count('u3', 900), count('u1', 400), count('uP', 3), count('u2', 2)];
});

describe('the Audit log page reads a bounded number of audit rows (review db-schema-2)', () => {
  it('two audit reads: the newest 200 rows and the 25 per-user counts; none asks Prisma for distinct rows', async () => {
    await shown();
    const audit = S.state.calls.filter((c) => c.model === 'auditLog');
    // Before: a third read, findMany({ where: { userId: { in: [...] } }, distinct: ['userId'], include: { user } })
    // with no `take` - every audit row of those users, JSON included.
    expect(audit.map((c) => c.op)).toEqual(['findMany', 'groupBy']);
    for (const c of audit) {
      expect(c.args.distinct, `${c.op} without distinct`).toBeUndefined();
      expect(c.args.take, `${c.op} is bounded`).toBeGreaterThan(0);
      expect(c.args.take).toBeLessThanOrEqual(200);
    }
    expect(audit[0].args).toEqual({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    // The counts: one row per user, from the index on (tenantId, userId, createdAt) (tenantDb adds the
    // company to `where`; this fake does not, so the page's own filter is what is checked here).
    expect(audit[1].args).toEqual({
      by: ['userId'],
      where: { userId: { not: null } },
      _count: { userId: true },
      orderBy: { _count: { userId: 'desc' } },
      take: 25,
    });
  });

  it('the names are read from the users table, for the counted ids only, and only the name and email', async () => {
    await shown();
    const lookups = S.state.calls.filter((c) => c.model === 'user');
    expect(lookups).toEqual([
      { model: 'user', op: 'findMany', args: { where: { id: { in: ['u3', 'u1', 'uP', 'u2'] } }, select: { id: true, name: true, email: true } } },
    ]);
  });

  it('the same users as before, most audit rows first; a platform admin who looked at the company stays in the list', async () => {
    const { users, initial } = await shown();
    expect(users).toEqual([
      { id: 'u3', name: 'Admin Three', email: 'three@a.example' },
      { id: 'u1', name: 'Dispatcher One', email: 'one@a.example' },
      { id: 'uP', name: 'Platform Admin', email: 'platform@routeiq.example' },
      { id: 'u2', name: 'Dispatcher Two', email: 'two@a.example' },
    ]);
    // A user of another company with no row here is never listed; nothing else leaves the server.
    expect(users.map((u) => u.id)).not.toContain('uB');
    expect(JSON.stringify(users)).not.toContain('passwordHash');
    expect(initial.map((r) => r.id)).toEqual(['a1', 'a2']);
  });

  it('a counted id with no user to show is left out, as before', async () => {
    S.state.counts = [count('u1', 5), count('gone', 4)];
    expect((await shown()).users.map((u) => u.id)).toEqual(['u1']);
  });

  it('no audit row with a user: no user lookup, an empty list', async () => {
    S.state.counts = [];
    expect((await shown()).users).toEqual([]);
    expect(S.state.calls.filter((c) => c.model === 'user')).toEqual([]);
  });
});
