'use strict';
// The PDF renderer process outside production (`next dev`, the tests; review M3): builds the renderer
// bundle when one of its sources changed (scripts/pdf-renderer-build.cjs), then runs it. The web
// process forks this file (lib/pdf-render/index.ts); it is plain CommonJS, so neither webpack nor the
// test runner ever loads esbuild. In production `next start` forks the bundle `pnpm build` made.
const { DEV_OUT, ensurePdfRenderer } = require('./pdf-renderer-build.cjs');

require(ensurePdfRenderer(DEV_OUT));
