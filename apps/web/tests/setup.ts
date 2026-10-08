// Vitest setup, run before every spec file.
//
// Uploads (audit P5): the routes read a file in a separate parser process (lib/upload-parse). Under
// the tests it is read in THIS process by default, so the specs that watch or replace SheetJS
// (vi.mock / vi.spyOn on 'xlsx') see the read, as before. The same request and answer objects are
// used, and the answer is copied as it would cross the process boundary. The module is imported
// only when a file is read, so a spec's vi.mock('xlsx') applies to it. lib/upload-parse honours
// this outside production only. Specs that test the real process turn it off
// (tests/lib/upload-parse-helpers.ts: useRealUploadParser()).
import type { RenderReply, RenderRequest } from '@/lib/pdf-render/protocol';
import type { ParseReply, ParseRequest } from '@/lib/upload-parse/protocol';

(globalThis as { __routeiqUploadParseInProcess?: (req: ParseRequest) => Promise<ParseReply> }).__routeiqUploadParseInProcess = async (req) =>
  (await import('@/lib/upload-parse/handler')).handleParseRequest(req);

// Driver sheets (review M3): the export route makes a pack in a separate PDF renderer process
// (lib/pdf-render). Under the tests it is made in THIS process by default, from a structured copy of
// the same request, and the answer is copied as it would cross the process boundary. Specs that test
// the real process turn it off (tests/lib/pdf-render-process.spec.ts).
(globalThis as { __routeiqPdfRenderInProcess?: (req: RenderRequest) => Promise<RenderReply> }).__routeiqPdfRenderInProcess = async (req) =>
  (await import('@/lib/pdf-render/handler')).handleRenderRequest(req);
