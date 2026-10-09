'use strict';
// A stand-in for the PDF renderer process (tests/lib/pdf-render-process.spec.ts, review M3). The file
// name says what it answers when it gets the pack (the web process forks it with no arguments):
//   echo.cjs - a "PDF" whose bytes are what it was started with, as JSON: its environment's names,
//              its Node flags, its pid, and the number of sheets it was sent
//   big.cjs  - a "PDF" of 2 MB, whatever the request's limit on it (lib/pdf-render/protocol.ts:
//              MAX_PDF_BYTES)
// The stand-ins that answer nothing (busy, crash, silent, hog) or nonsense (garbage) are the upload
// parser's (tests/fixtures/upload-parser): they do the same whatever they are sent.
module.exports = function standIn(mode) {
  process.once('message', (req) => {
    const done = (reply) => process.send(reply, () => process.exit(0));
    if (mode === 'echo') {
      const info = { env: Object.keys(process.env).sort().join(','), execArgv: process.execArgv.join(' '), pid: process.pid, sheets: req.model.sheets.length };
      return done({ ok: true, pdf: new Uint8Array(Buffer.from(JSON.stringify(info))) });
    }
    if (mode === 'big') return done({ ok: true, pdf: new Uint8Array(2 * 1024 * 1024).fill(37) });
    throw new Error(`unknown stand-in mode ${mode}`);
  });
};
