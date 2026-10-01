import { NextResponse } from 'next/server';
import { withTenantApi, ok, fail } from '@/lib/api';
import { prisma } from '@/lib/db';
import { buildWorklistWorkbook, loadWorklist } from '@/lib/dispatch/customer-master';
import { DATA_COLLECT_DAYS_MAX } from '@/lib/dispatch/data-collection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * GET /api/customers/data-to-collect?days=3&depotId=...&format=xlsx (owner decision 1 Oct 2026, item
 * 4): the customers with open orders from today to `days` days ahead (default: Settings "Data to
 * collect: days ahead") that miss a usable location or their own confirmed receiving hours, counted per
 * depot and per day. `depotId`: only the rows of that depot (the counts stay for every depot).
 * `format=xlsx`: the Excel for the people who collect the data (it imports back on Customers > Import).
 * Dispatchers and up: it lists customer data.
 */
export const GET = withTenantApi(
  async (req, { user }) => {
    const url = new URL(req.url);
    const daysRaw = url.searchParams.get('days');
    const days = daysRaw === null || daysRaw === '' ? null : Number(daysRaw);
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > DATA_COLLECT_DAYS_MAX)) {
      return fail(`days must be a whole number from 0 to ${DATA_COLLECT_DAYS_MAX}.`, 400);
    }
    const depotId = url.searchParams.get('depotId');
    const list = await loadWorklist(user.tenantId, { days });
    const depot = depotId ? list.perDepot.find((d) => d.depotId === depotId) : null;
    if (depotId && !depot) return fail('Depot not found.', 404);
    const rows = depot ? list.rows.filter((r) => r.depots.includes(depot.code)) : list.rows;
    if (url.searchParams.get('format') === 'xlsx') {
      const cfg = await prisma.tenantConfig.findUnique({ where: { tenantId: user.tenantId }, select: { timezone: true } });
      const buf = await buildWorklistWorkbook({ ...list, rows }, { generatedBy: user.name || user.email, generatedAt: new Date(), timezone: cfg?.timezone ?? 'Asia/Muscat' });
      const bytes = new Uint8Array(buf);
      const name = `data-to-collect-${list.today}${depot ? `-${depot.code}` : ''}.xlsx`.replace(/[^A-Za-z0-9._-]/g, '_');
      return new NextResponse(bytes, {
        status: 200,
        headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': bytes.byteLength.toString() },
      });
    }
    const { master: _master, ...rest } = list;
    return ok({ ...rest, rows, depotId: depot?.depotId ?? null });
  },
  { role: 'PLANNER' },
);
