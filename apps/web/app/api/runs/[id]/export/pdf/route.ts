import { NextResponse } from 'next/server';
import { withTenantApi, fail, type AuthedContext } from '@/lib/api';
import { prisma } from '@/lib/db';
import { buildRouteSheet } from '@/lib/exports/route-sheet-data';
import { buildRouteSheetPdf } from '@/lib/exports/pdf';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { driverPackModel, renderDriverPackPdf } from '@/lib/dispatch/driver-pack';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

function pdfResponse(buf: Buffer, filename: string, disposition: 'inline' | 'attachment') {
  const bytes = new Uint8Array(buf);
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${filename}"`,
      'Content-Length': bytes.byteLength.toString(),
    },
  });
}

// Codes are free text - keep the download filename header-safe.
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_') || 'X';

// NMWC dispatch plan version (has physical loads) -> driver sheets, one section per load.
// ?load=<loadId> one load, ?truck=<truckId or code> every load of that truck.
async function driverSheets(r: Request, runId: string, { user }: AuthedContext) {
  const detail = await getPlanDetail(user.tenantId, runId);
  if (!detail) return fail('Not found', 404);
  const url = new URL(r.url);
  const loadId = url.searchParams.get('load');
  const truck = url.searchParams.get('truck');
  let loads = detail.loads;
  if (loadId) loads = loads.filter((l) => l.id === loadId);
  if (truck) loads = loads.filter((l) => l.truckId === truck || l.truckCode === truck);
  if ((loadId || truck) && !loads.length) return fail(loadId ? 'Load not found in this plan.' : 'Truck has no load in this plan.', 404);
  const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } });
  const buf = await renderDriverPackPdf(driverPackModel(detail, { tenantName: tenant?.name ?? '', loadIds: loads.map((l) => l.id) }));
  // A filtered pack is one truck (and, for ?load=, one trip of it).
  const suffix = loadId || truck ? `-${safe(loads[0].truckCode)}${loadId ? `-trip${loads[0].loadNo}` : ''}` : '';
  // Inline: opens in the browser's PDF viewer, ready to print or share; the name is used on save.
  return pdfResponse(buf, `driver-sheets-${detail.run.runDate}-v${detail.run.version}${suffix}.pdf`, 'inline');
}

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (r, ctx) => {
    if ((await ctx.db.planLoad.count({ where: { runId: params.id } })) > 0) return driverSheets(r, params.id, ctx);

    // Legacy route-sheet export (runs without dispatch loads) - unchanged.
    const url = new URL(r.url);
    const truck = url.searchParams.get('truck') || undefined;

    const sheet = await buildRouteSheet(ctx.user.tenantId, params.id);
    const buf = await buildRouteSheetPdf(sheet, truck);

    const base = `routeiq-${sheet.run.depotCode}-${sheet.run.runDate}${truck ? `-${truck}` : ''}.pdf`;
    return pdfResponse(buf, base, 'attachment');
  })(req);
