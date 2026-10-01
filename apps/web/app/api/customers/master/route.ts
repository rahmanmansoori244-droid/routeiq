import { NextResponse } from 'next/server';
import { withTenantApi, fail } from '@/lib/api';
import { prisma } from '@/lib/db';
import { buildMasterWorkbook } from '@/lib/dispatch/customer-master';
import { MASTER_SINCE_MAX_DAYS } from '@/lib/dispatch/data-collection';
import { addDaysIso, todayIso } from '@/lib/dispatch/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * GET /api/customers/master?since=YYYY-MM-DD (owner decision 1 Oct 2026, item 6): the customer master
 * as Excel - every customer (importable back on Customers > Import), the customers changed since the
 * company's midnight of `since` (default: the last 24 hours), and the customers still missing data.
 * Dispatchers and up. `since` goes back at most MASTER_SINCE_MAX_DAYS days (data collection review):
 * every customer audit row of the period, with its whole before and after, is read to build the file.
 */
export const GET = withTenantApi(
  async (req, { user }) => {
    const since = new URL(req.url).searchParams.get('since');
    if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`)))) return fail('since must be a date (YYYY-MM-DD).', 400);
    if (since) {
      const cfg = await prisma.tenantConfig.findUnique({ where: { tenantId: user.tenantId }, select: { timezone: true } });
      const earliest = addDaysIso(todayIso(cfg?.timezone ?? 'Asia/Muscat'), -MASTER_SINCE_MAX_DAYS);
      if (since < earliest) return fail(`Changed since: pick a date at most ${MASTER_SINCE_MAX_DAYS} days back (${earliest} or later).`, 400);
    }
    const wb = await buildMasterWorkbook(user.tenantId, { sinceIso: since, generatedBy: user.name || user.email });
    const bytes = new Uint8Array(wb.buffer);
    return new NextResponse(bytes, {
      status: 200,
      headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${wb.fileName}"`, 'Content-Length': bytes.byteLength.toString() },
    });
  },
  { role: 'PLANNER' },
);
