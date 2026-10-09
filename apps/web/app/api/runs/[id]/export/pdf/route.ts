import { NextResponse } from 'next/server';
import { withTenantApi, fail, hasRole, type AuthedContext } from '@/lib/api';
import { prisma } from '@/lib/db';
import { buildRouteSheet } from '@/lib/exports/route-sheet-data';
import { buildRouteSheetPdf } from '@/lib/exports/pdf';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { driverPackModel, type SheetDriverLink } from '@/lib/dispatch/driver-pack';
import { PdfRenderRefused, pdfRefusedResponse, renderDriverPackIsolated } from '@/lib/pdf-render';
import { isDispatchPlan } from '@/lib/dispatch/legacy-runs';
import { ensureLink, listLinks } from '@/lib/driver-link/service';

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

async function packDriverLinks(user: AuthedContext['user'], runId: string, truckIds: string[], origin: string): Promise<Map<string, SheetDriverLink | null>> {
  const out = new Map<string, SheetDriverLink | null>();
  // The links that exist and work already, read in one batch: only the others go through ensureLink
  // (one transaction each: a new link, a rotated server key, a link made before a driver was set).
  const known = new Map((await listLinks(user.tenantId, runId, { origin }).catch(() => [])).map((v) => [v.truckId, v]));
  for (const truckId of truckIds) {
    const v = known.get(truckId);
    if (v?.url && v.driverIdAtIssue) {
      out.set(truckId, { kind: 'QR', url: v.url });
      continue;
    }
    if (v?.revoked) {
      out.set(truckId, { kind: 'STOPPED' });
      continue;
    }
    try {
      const v = await ensureLink(user.tenantId, runId, truckId, user.id, { origin });
      out.set(truckId, v.url ? { kind: 'QR', url: v.url } : v.revoked ? { kind: 'STOPPED' } : { kind: 'ASK' });
    } catch (e) {
      const code = (e as { details?: { code?: unknown } } | null)?.details?.code;
      out.set(truckId, code === 'LINK_DAY_OVER' ? null : { kind: 'ASK' });
      if (code !== 'LINK_DAY_OVER') console.warn('[pdf] driver link not made for a truck', { runId, truckId, code: code ?? (e as Error)?.message });
    }
  }
  return out;
}

// NMWC dispatch plan version -> driver sheets, one section per load.
// ?load=<loadId> one load, ?truck=<truckId or code> every load of that truck.
// Driver sheets only (audit F16): a dispatch plan without loads (every order unserved) has none;
// its unserved orders are in the Excel workbook. Never the legacy route sheet for a dispatch plan.
async function driverSheets(r: Request, runId: string, { user }: AuthedContext) {
  const detail = await getPlanDetail(user.tenantId, runId);
  if (!detail) return fail('Not found', 404);
  if (!detail.loads.length) {
    return fail({ code: 'NO_LOADS', message: 'This plan has no loads, so there are no driver sheets. Its unserved orders are in the Excel export.' }, 404);
  }
  const url = new URL(r.url);
  const loadId = url.searchParams.get('load');
  const truck = url.searchParams.get('truck');
  let loads = detail.loads;
  if (loadId) loads = loads.filter((l) => l.id === loadId);
  if (truck) loads = loads.filter((l) => l.truckId === truck || l.truckCode === truck);
  if ((loadId || truck) && !loads.length) return fail(loadId ? 'Load not found in this plan.' : 'Truck has no load in this plan.', 404);
  const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } });
  // The driver link (QR) per truck-day, printed only for PLANNER and above: the link can record
  // delivery results, and this PDF is readable by every role (a VIEWER's sheets say "ask the
  // dispatcher"). Each truck-day in its own transaction; a failure prints the same placeholder on that
  // truck's sheets and never fails the pack. Revoked: "Driver link stopped"; its day over: nothing.
  const driverLinks = hasRole(user.role, 'PLANNER') ? await packDriverLinks(user, runId, [...new Set(loads.map((l) => l.truckId))], new URL(r.url).origin) : undefined;
  // Laid out in the PDF renderer process (review M3): seconds of CPU per pack that would otherwise
  // freeze the web process for every user. Too long, too much memory, the maker stopped, or busy (503).
  let buf: Buffer;
  try {
    buf = await renderDriverPackIsolated(driverPackModel(detail, { tenantName: tenant?.name ?? '', loadIds: loads.map((l) => l.id), driverLinks }));
  } catch (err) {
    if (err instanceof PdfRenderRefused) return pdfRefusedResponse(err);
    throw err;
  }
  // A filtered pack is one truck (and, for ?load=, one trip of it).
  const suffix = loadId || truck ? `-${safe(loads[0].truckCode)}${loadId ? `-trip${loads[0].loadNo}` : ''}` : '';
  // Inline: opens in the browser's PDF viewer, ready to print or share; the name is used on save.
  return pdfResponse(buf, `driver-sheets-${detail.run.runDate}-v${detail.run.version}${suffix}.pdf`, 'inline');
}

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (r, ctx) => {
    if (await isDispatchPlan(ctx.user.tenantId, params.id)) return driverSheets(r, params.id, ctx);

    // Legacy route-sheet export (May-2026 runs, not dispatch plans) - unchanged.
    const url = new URL(r.url);
    const truck = url.searchParams.get('truck') || undefined;

    const sheet = await buildRouteSheet(ctx.user.tenantId, params.id);
    const buf = await buildRouteSheetPdf(sheet, truck);

    const base = `routeiq-${sheet.run.depotCode}-${sheet.run.runDate}${truck ? `-${truck}` : ''}.pdf`;
    return pdfResponse(buf, base, 'attachment');
  })(req);
