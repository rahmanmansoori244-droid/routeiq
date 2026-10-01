import { NextResponse } from 'next/server';
import { withTenantApi, fail } from '@/lib/api';
import { buildMasterWorkbook } from '@/lib/dispatch/customer-master';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * GET /api/customers/master?since=YYYY-MM-DD (owner decision 1 Oct 2026, item 6): the customer master
 * as Excel - every customer (importable back on Customers > Import), the customers changed since the
 * company's midnight of `since` (default: the last 24 hours), and the customers still missing data.
 * Dispatchers and up.
 */
export const GET = withTenantApi(
  async (req, { user }) => {
    const since = new URL(req.url).searchParams.get('since');
    if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`)))) return fail('since must be a date (YYYY-MM-DD).', 400);
    const wb = await buildMasterWorkbook(user.tenantId, { sinceIso: since, generatedBy: user.name || user.email });
    const bytes = new Uint8Array(wb.buffer);
    return new NextResponse(bytes, {
      status: 200,
      headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${wb.fileName}"`, 'Content-Length': bytes.byteLength.toString() },
    });
  },
  { role: 'PLANNER' },
);
