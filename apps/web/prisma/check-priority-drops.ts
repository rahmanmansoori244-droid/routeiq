/**
 * Verify the §13 priority-inverted drop penalty for a specific run:
 * unserved orders should be heavily weighted toward LOW priority (5),
 * with ZERO priority-1 customers dropped.
 *
 *   DATABASE_URL=... tsx prisma/check-priority-drops.ts --run=<runId>
 */

import { PrismaClient, UnservedReasonCode } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  let runId: string | null = null;
  for (const a of process.argv.slice(2)) {
    const m = /^--run=(.+)$/.exec(a);
    if (m) runId = m[1];
  }
  if (!runId) {
    const latest = await prisma.runPlan.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { id: true, runDate: true },
    });
    if (!latest) throw new Error('No runs found.');
    runId = latest.id;
    console.log(`No --run= given; using latest: ${runId} (${latest.runDate.toISOString().slice(0, 10)})`);
  }

  const scenarios = await prisma.scenarioResult.findMany({
    where: { runId },
    include: {
      unservedOrders: {
        include: { order: { include: { customer: { select: { code: true, name: true, priority: true } } } } },
      },
    },
    orderBy: { name: 'asc' },
  });

  console.log(`Run ${runId}: ${scenarios.length} scenario(s)`);
  for (const s of scenarios) {
    console.log(`\n[${s.name}] ${s.trucksUsed} trucks, ${s.totalDistanceKm.toFixed(1)} km, util ${s.avgUtilizationPct.toFixed(1)}%`);
    console.log(`  ${s.unservedOrders.length} unserved order(s)`);
    const byPriority: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const reasons: Record<string, number> = {};
    for (const u of s.unservedOrders) {
      const p = u.order.customer.priority ?? 0;
      byPriority[p] = (byPriority[p] || 0) + 1;
      reasons[u.reasonCode] = (reasons[u.reasonCode] || 0) + 1;
    }
    console.log(`  Priority breakdown: ${JSON.stringify(byPriority)}`);
    console.log(`  Reason codes:       ${JSON.stringify(reasons)}`);
    if (byPriority[1] > 0) {
      console.log(`  ❌ FAIL — ${byPriority[1]} priority-1 customers were dropped! Priority inversion is broken.`);
    } else {
      console.log(`  ✅ PASS — zero priority-1 drops.`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
