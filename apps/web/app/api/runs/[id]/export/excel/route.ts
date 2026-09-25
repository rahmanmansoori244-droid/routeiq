import { NextResponse } from 'next/server';
import { withTenantApi, fail, type AuthedContext } from '@/lib/api';
import { prisma } from '@/lib/db';
import { buildRouteSheet } from '@/lib/exports/route-sheet-data';
import { buildRouteSheetExcel } from '@/lib/exports/excel';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { buildDispatchWorkbook, tenantAssumptions } from '@/lib/dispatch/workbook';
import { routingProviderFor } from '@/lib/dispatch/customer-attrs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function xlsxResponse(buf: Buffer, filename: string) {
  const bytes = new Uint8Array(buf);
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      'Content-Type': XLSX,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': bytes.byteLength.toString(),
    },
  });
}

// NMWC dispatch plan version (has physical loads) -> the master dispatch workbook.
// Review F08: the ASSUMPTIONS sheet shows the settings stored with the plan in use (what it was
// built with, including whether it was outside the routing map); only a plan from before settings
// were stored shows today's, labelled as such. Never the web server's environment (OSRM_URL here
// only draws the legacy Map tab; the solver routes with its own).
async function dispatchWorkbook(runId: string, { user, db }: AuthedContext) {
  const detail = await getPlanDetail(user.tenantId, runId);
  if (!detail) return fail('Not found', 404);
  const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true, currency: true, country: true } });
  const cfg = await db.tenantConfig.findUnique({ where: { tenantId: user.tenantId } });
  const currency = tenant?.currency ?? 'OMR';
  const planned = detail.planSettings ?? null;
  const buf = await buildDispatchWorkbook(detail, {
    tenantName: tenant?.name ?? '',
    currency,
    generatedAt: new Date(),
    generatedBy: user.name || user.email,
    timezone: planned?.timezone ?? cfg?.timezone,
    assumptions: tenantAssumptions(planned ?? cfg, {
      currency,
      providerUsed: detail.summary?.distanceProvider ?? detail.scenarios.find((s) => s.chosen)?.provider ?? null,
      distanceIsEstimated: detail.summary?.distanceIsEstimated ?? detail.loads.some((l) => l.distanceIsEstimated),
      // Stored with the plan (PlanSettings.outsideCoverage); today's only for a plan without settings.
      outsideCoverage: planned ? undefined : cfg ? routingProviderFor(cfg, tenant?.country).outsideCoverage : false,
    }),
    assumptionsSource: planned ? 'PLAN' : 'CURRENT',
  });
  // Depot codes are free text - keep the download filename header-safe.
  const depot = detail.run.depot.code.replace(/[^A-Za-z0-9_-]+/g, '_') || 'DEPOT';
  return xlsxResponse(buf, `nmwc-dispatch-${depot}-${detail.run.runDate}-v${detail.run.version}.xlsx`);
}

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (r, ctx) => {
    if ((await ctx.db.planLoad.count({ where: { runId: params.id } })) > 0) return dispatchWorkbook(params.id, ctx);

    // Legacy route-sheet export (runs without dispatch loads) - unchanged.
    const url = new URL(r.url);
    const truck = url.searchParams.get('truck') || undefined;

    const sheet = await buildRouteSheet(ctx.user.tenantId, params.id);
    const buf = await buildRouteSheetExcel(sheet, truck);

    const base = `routeiq-${sheet.run.depotCode}-${sheet.run.runDate}${truck ? `-${truck}` : ''}.xlsx`;
    return xlsxResponse(buf, base);
  })(req);
