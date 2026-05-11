import { NextResponse } from 'next/server';
import { withTenantApi } from '@/lib/api';
import { buildRouteSheet } from '@/lib/exports/route-sheet-data';
import { buildRouteSheetExcel } from '@/lib/exports/excel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (r, { user }) => {
    const url = new URL(r.url);
    const truck = url.searchParams.get('truck') || undefined;

    const sheet = await buildRouteSheet(user.tenantId, params.id);
    const buf = await buildRouteSheetExcel(sheet, truck);
    const bytes = new Uint8Array(buf);

    const base = `routeiq-${sheet.run.depotCode}-${sheet.run.runDate}${truck ? `-${truck}` : ''}.xlsx`;
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${base}"`,
        'Content-Length': bytes.byteLength.toString(),
      },
    });
  })(req);
