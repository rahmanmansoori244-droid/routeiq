/**
 * The PDF renderer process's work (lib/pdf-render/child.ts): the driver pack laid out by the unchanged
 * renderDriverPackPdf (lib/dispatch/driver-pack-pdf.tsx) from the model it was sent. Every error is
 * caught and sent back as data. Only the renderer process runs this (and the tests, in-process:
 * tests/setup.ts); the web process never loads it.
 */
import { renderDriverPackPdf } from '../dispatch/driver-pack-pdf';
import { MAX_PDF_BYTES, type RenderReply, type RenderRequest } from './protocol';

export async function handleRenderRequest(req: RenderRequest): Promise<RenderReply> {
  try {
    const pdf = await renderDriverPackPdf(req.model);
    // Never more than the web process takes: it would hold all of it before it could say no.
    if (pdf.byteLength > (req.maxPdfBytes ?? MAX_PDF_BYTES)) return { ok: false, tooLarge: pdf.byteLength };
    return { ok: true, pdf: new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength) };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { ok: false, error: { name: e.name, message: e.message } };
  }
}
