/**
 * What the web process and the PDF renderer process (lib/pdf-render) send each other. Only data
 * crosses: the driver pack's model (DriverPackModel, plain data made by driverPackModel in the web
 * process) and the most the PDF may be one way; the PDF's bytes, or what went wrong, the other way.
 * One message each way.
 */
import type { DriverPackModel } from '../dispatch/driver-pack';

/** The one message the renderer process gets. */
export interface RenderRequest {
  model: DriverPackModel;
  /** The most the PDF may be, in bytes (MAX_PDF_BYTES when not given; smaller in tests). */
  maxPdfBytes?: number;
}

/**
 * The renderer process's one answer: the PDF, or the error the layout threw (its name and message),
 * or `tooLarge` (the PDF's bytes, more than the request's limit: nothing of it is sent). `maxRssKB`
 * is the process's peak memory (process.resourceUsage).
 */
export type RenderReply = ({ ok: true; pdf: Uint8Array } | { ok: false; error: { name: string; message: string } } | { ok: false; tooLarge: number }) & {
  maxRssKB?: number;
};

/**
 * The most a PDF may be: 64 MB. A whole day's pack of 400 stops is about 1.4 MB (49 pages), so only
 * a broken renderer comes near it; past it the pack is refused "needs too much memory".
 */
export const MAX_PDF_BYTES = 64 * 1024 * 1024;

/** Whether a value is a RenderReply (anything else from the renderer process is treated as a crash). */
export function isRenderReply(m: unknown): m is RenderReply {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as { ok?: unknown; pdf?: unknown; error?: unknown; tooLarge?: unknown };
  if (r.ok === true) return r.pdf instanceof Uint8Array;
  if (r.ok !== false) return false;
  if (typeof r.tooLarge === 'number') return true;
  const e = r.error as { name?: unknown; message?: unknown } | null | undefined;
  return typeof e === 'object' && e !== null && typeof e.name === 'string' && typeof e.message === 'string';
}

/**
 * The smallest pack (one sheet of one load without stops): the startup check of a production server
 * and the CI build check render it, to know the renderer works before a dispatcher prints.
 */
export const CHECK_MODEL: DriverPackModel = {
  title: 'Driver sheets check',
  tenantName: 'RouteIQ',
  runDate: '2026-01-01',
  version: 1,
  superseded: false,
  depot: { code: 'CHK', name: 'Check' },
  timesNotVerified: false,
  sheets: [
    {
      loadId: 'check',
      truckId: 'check',
      truckCode: 'CHECK-1',
      trip: 1,
      trips: 1,
      status: 'PLANNED',
      carried: false,
      badges: ['PLANNED - not locked yet'],
      driverName: null,
      driverPhone: null,
      depart: '06:00',
      back: '07:00',
      breakTimes: null,
      breakBefore: null,
      cases: 0,
      capacityCases: 100,
      pallets: null,
      kmLabel: 'Road km',
      km: 0,
      loadCheck: { items: [], total: 0, matchesLoad: true },
      route: { links: [], skipped: [] },
      stops: [],
      returnText: 'Return to depot CHK ~07:00 - last trip of the day.',
      footerText: 'CHECK-1 trip 1 of 1',
      unprintable: false,
      timesNotVerified: false,
      qrCodes: [],
      driverLinkNote: null,
    },
  ],
};
