import { NextResponse } from 'next/server';
import { withTenantApi, HttpError } from '@/lib/api';
import { isRealIsoDate } from '@/lib/schemas';
import { daysBetween } from '@/lib/dispatch/time';
import { CREW_MAX_DAYS } from '@/lib/dispatch/crew-report-view';
import { buildCrewWorkbook, readCrewReport } from '@/lib/dispatch/crew-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// GET /api/dispatch/crew-report?from=YYYY-MM-DD&to=YYYY-MM-DD&depotId= - the "Crew report" Excel (owner
// request 13 Oct 2026: management wants to know who were the driver and the helpers on each truck and
// load). One row per load of the plan in use of each depot and day (31 days at most; every depot
// without depotId). Every role, like the plan's Excel and PDF (names and times, no money). Reads only.
export const GET = withTenantApi(async (req, { user, db }) => {
  const url = new URL(req.url);
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? from;
  const depotId = url.searchParams.get('depotId') || null;
  if (!isRealIsoDate(from) || !isRealIsoDate(to)) throw new HttpError('Use real dates as YYYY-MM-DD.', 400, { code: 'INVALID_DATE' });
  if (to < from) throw new HttpError('"to" must not be before "from".', 400, { code: 'INVALID_RANGE' });
  if (daysBetween(from, to) + 1 > CREW_MAX_DAYS) throw new HttpError(`At most ${CREW_MAX_DAYS} days at a time.`, 400, { code: 'RANGE_TOO_LONG' });
  if (depotId && !(await db.depot.findFirst({ where: { id: depotId }, select: { id: true } }))) throw new HttpError('Depot not found.', 404, { code: 'DEPOT_NOT_FOUND' });
  const { rows, depot } = await readCrewReport(user.tenantId, { from, to }, depotId);
  const tenant = await db.tenant.findFirst({ where: { id: user.tenantId }, select: { name: true } });
  const buf = await buildCrewWorkbook(rows, { tenantName: tenant?.name ?? '', from, to, depot, generatedAt: new Date(), generatedBy: user.name || user.email });
  const bytes = new Uint8Array(buf);
  const name = `crew-report-${from}${to !== from ? `_${to}` : ''}${depot ? `-${depot.replace(/[^A-Za-z0-9_-]/g, '')}` : ''}.xlsx`;
  return new NextResponse(bytes, {
    status: 200,
    headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': bytes.byteLength.toString(), 'Cache-Control': 'no-store' },
  });
});
