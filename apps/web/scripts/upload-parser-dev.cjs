'use strict';
// The upload parser process outside production (`next dev`, the tests; audit P5): builds the parser
// bundle when one of its sources changed (scripts/upload-parser-build.cjs), then runs it. The web
// process forks this file (lib/upload-parse/index.ts); it is plain CommonJS, so neither webpack nor
// the test runner ever loads esbuild. In production `next start` forks the bundle `pnpm build` made.
const { DEV_OUT, ensureUploadParser } = require('./upload-parser-build.cjs');

require(ensureUploadParser(DEV_OUT));
