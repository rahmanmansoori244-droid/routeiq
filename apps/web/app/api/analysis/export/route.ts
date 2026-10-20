import { NextResponse } from 'next/server';
import { withTenantApi, HttpError } from '@/lib/api';
import { isRealIsoDate } from '@/lib/schemas';
import { daysBetween } from '@/lib/dispatch/time';
import { buildAlertCausesWorkbook, buildAnalysisWorkbook, readAnalysis, type AnalysisDb } from '@/lib/analysis/export';
import { analysisMaxDays } from '@/lib/analysis/view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// GET /api/analysis/export?from=YYYY-MM-DD&to=YYYY-MM-DD&depotId=&only= - the "Analysis data" Excel (owner request
// 19 Oct 2026: "build on more data for our analysis later and improvement"; lib/analysis/export.ts): the
// facts the nightly job keeps (truck days, visits, sub-stays, legs, depot turns), the pins to review, the
// late result taps and, last, the alert causes & actions (owner request 20 Oct 2026: every operations alert of
// the range with what the office recorded after checking it), for at most 92 delivery dates. `only=alerts`: the
// ReadMe and the alert causes & actions alone (the Alerts page's Excel link), up to 366 dates; any other `only`
// is 400 INVALID_ONLY. Company admin and dispatcher (PLANNER and up): the "Pins to review" sheet holds standing
// points worked out from the customer pins - office data, never a VIEWER's, never public. Every read goes
// through the caller's company (tenantDb): another company's depot is 404 and another company's rows are never
// in the file. Reads only, no money, no driver, never the raw GPS trail.
export const GET = withTenantApi(
  async (req, { user, db }) => {
    const url = new URL(req.url);
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? from;
    const depotId = url.searchParams.get('depotId') || null;
    const onlyRaw = url.searchParams.get('only');
    if (onlyRaw !== null && onlyRaw !== 'alerts') throw new HttpError('"only" is alerts or absent.', 400, { code: 'INVALID_ONLY' });
    const only = onlyRaw === 'alerts' ? 'alerts' : undefined;
    const maxDays = analysisMaxDays(only);
    if (!isRealIsoDate(from) || !isRealIsoDate(to)) throw new HttpError('Use real dates as YYYY-MM-DD.', 400, { code: 'INVALID_DATE' });
    if (to < from) throw new HttpError('"to" must not be before "from".', 400, { code: 'INVALID_RANGE' });
    if (daysBetween(from, to) + 1 > maxDays) throw new HttpError(`At most ${maxDays} days at a time.`, 400, { code: 'RANGE_TOO_LONG' });
    const depot = depotId ? await db.depot.findFirst({ where: { id: depotId, tenantId: user.tenantId }, select: { id: true, code: true } }) : null;
    if (depotId && !depot) throw new HttpError('Depot not found.', 404, { code: 'DEPOT_NOT_FOUND' });
    const data = await readAnalysis(db as unknown as AnalysisDb, user.tenantId, { from, to }, depotId, { only });
    const tenant = await db.tenant.findFirst({ where: { id: user.tenantId }, select: { name: true } });
    const meta = { tenantName: tenant?.name ?? '', from, to, depot: depot?.code ?? null, generatedAt: new Date(), generatedBy: user.name || user.email };
    const buf = only === 'alerts' ? await buildAlertCausesWorkbook(data, meta) : await buildAnalysisWorkbook(data, meta);
    const bytes = new Uint8Array(buf);
    const name = `${only === 'alerts' ? 'alert-causes' : 'analysis-data'}-${from}${to !== from ? `_${to}` : ''}${depot ? `-${depot.code.replace(/[^A-Za-z0-9_-]/g, '')}` : ''}.xlsx`;
    return new NextResponse(bytes, {
      status: 200,
      headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': bytes.byteLength.toString(), 'Cache-Control': 'no-store' },
    });
  },
  { role: 'PLANNER' },
);
