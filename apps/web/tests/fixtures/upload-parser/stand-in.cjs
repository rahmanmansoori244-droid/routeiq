'use strict';
// A stand-in for the upload parser process (tests/lib/upload-parse-process.spec.ts, audit P5). The
// file name says what it does when it gets the file (the web process forks it with no arguments):
//   busy.cjs    - loops forever in plain JavaScript (a parse that never ends; only a kill stops it)
//   crash.cjs   - exits with code 7 without answering
//   silent.cjs  - exits with code 0 without answering
//   garbage.cjs - answers something that is not a parse result
//   hog.cjs     - allocates until its heap cap is reached (V8 aborts: "heap out of memory")
//   echo.cjs    - answers one row with what it was started with: its environment's names, its Node flags
module.exports = function standIn(mode) {
  process.once('message', () => {
    if (mode === 'busy') for (;;);
    if (mode === 'crash') process.exit(7);
    if (mode === 'silent') process.exit(0);
    if (mode === 'garbage') return process.send({ hello: 'world' }, () => process.exit(0));
    if (mode === 'hog') {
      const keep = [];
      for (;;) keep.push(new Array(10_000).fill({ a: keep.length }));
    }
    if (mode === 'echo') {
      const row = { env: Object.keys(process.env).sort().join(','), execArgv: process.execArgv.join(' '), pid: String(process.pid) };
      const reply = { ok: true, parsed: { fileName: 'echo', fileType: 'csv', rows: [row], warnings: [] } };
      process.send({ kind: 'rows', rows: [row] });
      return process.send({ kind: 'reply', reply: { ...reply, parsed: { ...reply.parsed, rows: [] } }, pieces: 1 }, () => process.exit(0));
    }
    throw new Error(`unknown stand-in mode ${mode}`);
  });
};
