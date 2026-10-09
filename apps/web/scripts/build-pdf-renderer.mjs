// Step of `pnpm build` after `next build` (review M3): bundles the PDF renderer into
// .next/pdf-renderer/render.cjs, the file `next start` forks for each driver pack (lib/pdf-render).
// Fails the build when the bundle holds anything but the renderer's own modules and what React,
// @react-pdf/renderer and qrcode bring in (scripts/pdf-renderer-build.cjs). CI checks and runs it
// (scripts/check-build-output.ts).
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildPdfRenderer, PROD_OUT, WEB } = require('./pdf-renderer-build.cjs');

const out = buildPdfRenderer(PROD_OUT);
console.log(`build-pdf-renderer: ${path.relative(WEB, out.file)} (${Math.round(out.bytes / 1024)} KB from ${out.inputs.length} files)`);
