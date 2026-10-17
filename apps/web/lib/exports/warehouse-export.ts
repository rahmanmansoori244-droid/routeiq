/**
 * The warehouse paperwork export (owner request 12 Oct 2026): the load sheets and the return notes
 * of a dispatch plan version, as printable HTML pages (lib/dispatch/warehouse-sheets*.ts). Shared by
 * the two export routes: the same reads, filters (?load=, ?truck=) and response headers.
 */
import { NextResponse } from 'next/server';
import { fail } from '@/lib/api';
import { prisma } from '@/lib/db';
import { getPlanDetail, type DetailLoad, type PlanDetail } from '@/lib/dispatch/plan-detail';
import { isDispatchPlan } from '@/lib/dispatch/legacy-runs';
import { readOutcomeOverlay } from '@/lib/delivery/outcome-view';
import { loadSheetModel, returnNoteModel, RETURN_NOTE_STATUSES } from '@/lib/dispatch/warehouse-sheets';
import { renderLoadSheetHtml, renderReturnNoteHtml, SHEET_CSP } from '@/lib/dispatch/warehouse-sheets-html';

/** A printable page: no cache, and a policy that allows its Print button and nothing else. */
export function sheetHtmlResponse(html: string): Response {
  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': SHEET_CSP,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** ?load=<loadId> one load, ?truck=<truck id or code> every load of that truck; else all. */
function pick(r: Request, loads: DetailLoad[]): { loads: DetailLoad[]; filtered: boolean; loadId: string | null } {
  const url = new URL(r.url);
  const loadId = url.searchParams.get('load');
  const truck = url.searchParams.get('truck');
  let out = loads;
  if (loadId) out = out.filter((l) => l.id === loadId);
  if (truck) out = out.filter((l) => l.truckId === truck || l.truckCode === truck);
  return { loads: out, filtered: !!(loadId || truck), loadId };
}

/**
 * The plan detail of a dispatch plan version of this company, or the 404 answer (another company's
 * run, a legacy route run, no such run). Shared with the Salesman ETA export (owner request 17 Oct 2026).
 */
export async function planOf(tenantId: string, runId: string): Promise<PlanDetail | Response> {
  // Dispatch plans only: a legacy route run has no loads, invoices or results to print.
  if (!(await isDispatchPlan(tenantId, runId))) return fail('Not found', 404);
  const detail = await getPlanDetail(tenantId, runId);
  if (!detail) return fail('Not found', 404);
  return detail;
}

/** The company's name, printed at the top of the pages. */
export const tenantNameOf = async (tenantId: string) => (await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }))?.name ?? '';

export async function loadSheetsExport(r: Request, tenantId: string, runId: string): Promise<Response> {
  const detail = await planOf(tenantId, runId);
  if (detail instanceof Response) return detail;
  if (!detail.loads.length) return fail({ code: 'NO_LOADS', message: 'This plan has no loads, so there are no load sheets.' }, 404);
  const { loads, filtered, loadId } = pick(r, detail.loads);
  if (filtered && !loads.length) return fail(loadId ? 'Load not found in this plan.' : 'Truck has no load in this plan.', 404);
  const model = loadSheetModel(detail, { tenantName: await tenantNameOf(tenantId), loadIds: loads.map((l) => l.id) });
  return sheetHtmlResponse(renderLoadSheetHtml(model));
}

export async function returnNotesExport(r: Request, tenantId: string, runId: string): Promise<Response> {
  const detail = await planOf(tenantId, runId);
  if (detail instanceof Response) return detail;
  const { loads, filtered, loadId } = pick(r, detail.loads);
  if (filtered && !loads.length) return fail(loadId ? 'Load not found in this plan.' : 'Truck has no load in this plan.', 404);
  const left = loads.filter((l) => RETURN_NOTE_STATUSES.has(l.status));
  if (!left.length) {
    return fail(
      { code: 'NOT_LEFT', message: 'No load here has left yet: a return note is printed after the truck is dispatched and back.' },
      404,
    );
  }
  const overlay = await readOutcomeOverlay(tenantId, runId);
  if (!overlay) return fail('Not found', 404);
  const model = returnNoteModel(detail, overlay, { tenantName: await tenantNameOf(tenantId), loadIds: left.map((l) => l.id) });
  return sheetHtmlResponse(renderReturnNoteHtml(model));
}
