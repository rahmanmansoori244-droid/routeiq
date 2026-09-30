'use strict';
// A stand-in for the upload parser process (tests/lib/upload-parse-process.spec.ts, audit P5). The
// file name says what it does when it gets the file (the web process forks it with no arguments):
//   busy.cjs    - loops forever in plain JavaScript (a parse that never ends; only a kill stops it)
//   crash.cjs   - exits with code 7 without answering
//   silent.cjs  - exits with code 0 without answering
//   garbage.cjs - answers something that is not a parse result
//   hog.cjs     - allocates until its heap cap is reached (V8 aborts: "heap out of memory")
//   echo.cjs    - answers one row with what it was started with: its environment's names, its Node flags
//   flood.cjs   - sends pieces of rows of 1 MB each without end, whatever the web process's limit
//                 on the answer (lib/upload-parse/protocol.ts: MAX_RESULT_BYTES); only a kill stops it
//   wide.cjs    - sends one row of 250,000 keys (each its own text, the value "1") and its reply: a row
//                 wider than any file within the upload caps gives (MAX_COLS, P5 second review)
const v8 = require('node:v8');

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
      // As lib/upload-parse/protocol.ts sends it: the texts, then the row as the numbers of its key and value texts.
      const texts = Object.entries(row).flat();
      const cells = Uint32Array.from([Object.keys(row).length, ...texts.map((_, i) => i)]);
      process.send({ kind: 'rows', bytes: v8.serialize({ texts, cells }) });
      const reply = { ok: true, parsed: { fileName: 'echo', fileType: 'csv', rows: [], warnings: [] } };
      return process.send({ kind: 'reply', bytes: v8.serialize(reply), pieces: 1 }, () => process.exit(0));
    }
    if (mode === 'flood') {
      // Piece i: one row { big: <1 MB of text, its own> } (the protocol's texts and cells).
      let i = 0;
      const next = () => {
        const texts = i === 0 ? ['big'] : [];
        texts.push(String(i).padEnd(1 << 20, 'x'));
        const cells = Uint32Array.from([1, 0, i + 1]);
        i += 1;
        process.send({ kind: 'rows', bytes: v8.serialize({ texts, cells }) }, undefined, undefined, (err) => (err ? undefined : setImmediate(next)));
      };
      return next();
    }
    if (mode === 'wide') {
      const n = 250_000;
      const texts = ['1'];
      const cells = new Uint32Array(1 + 2 * n);
      cells[0] = n;
      for (let c = 0; c < n; c++) {
        texts.push(`k${c}`);
        cells[1 + 2 * c] = c + 1;
        cells[2 + 2 * c] = 0;
      }
      process.send({ kind: 'rows', bytes: v8.serialize({ texts, cells }) });
      const reply = { ok: true, parsed: { fileName: 'wide', fileType: 'csv', rows: [], warnings: [] } };
      return process.send({ kind: 'reply', bytes: v8.serialize(reply), pieces: 1 }, () => process.exit(0));
    }
    throw new Error(`unknown stand-in mode ${mode}`);
  });
};
