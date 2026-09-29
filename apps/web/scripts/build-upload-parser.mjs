// Step of `pnpm build` after `next build` (audit P5): bundles the upload parser into
// .next/upload-parser/parse.cjs, the file `next start` forks for each upload (lib/upload-parse).
// Fails the build when the bundle holds anything but the parser's own modules, SheetJS's ESM build
// and Papa Parse (scripts/upload-parser-build.cjs). CI checks and runs it (scripts/check-build-output.ts).
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildUploadParser, PROD_OUT, WEB } = require('./upload-parser-build.cjs');

const out = buildUploadParser(PROD_OUT);
console.log(`build-upload-parser: ${path.relative(WEB, out.file)} (${Math.round(out.bytes / 1024)} KB from ${out.inputs.length} files)`);
