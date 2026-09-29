/**
 * Entry of the upload parser process (audit P5). The web process forks it once per upload
 * (lib/upload-parse/index.ts) with a heap cap (--max-old-space-size) and no secrets in its
 * environment, sends it one ParseRequest, and kills it when it takes too long. It reads the file
 * (handler.ts), sends the rows in pieces (each text once, at most the request's maxResultBytes in
 * all) and then its ParseReply with its peak memory, and exits (protocol.ts). It is bundled with
 * esbuild into
 * .next/upload-parser/parse.cjs by `pnpm build` (scripts/build-upload-parser.mjs); in development and
 * tests scripts/upload-parser-dev.cjs builds and runs the same bundle.
 */
import { writeFileSync } from 'node:fs';
import { handleParseRequest } from './handler';
import { answerMessages, type ParseRequest } from './protocol';

// Linux: when the machine (the Railway container) runs out of memory, the kernel kills the process
// with the highest score first. This one then goes before the web process. Best effort: raising
// its own score needs no privilege.
if (process.platform === 'linux') {
  try {
    writeFileSync('/proc/self/oom_score_adj', '1000');
  } catch {
    // not allowed here: the heap cap and the web service's memory still apply
  }
}

const send = process.send?.bind(process);
if (!send) {
  console.error('upload parser: start it with an IPC channel (child_process.fork)');
  process.exit(2);
}
// The web process went away (or closed the channel): nothing will read the answer.
process.on('disconnect', () => process.exit(0));

process.once('message', (req: ParseRequest) => {
  void handleParseRequest(req).then((reply) => {
    // The rows in pieces, then the reply (protocol.ts), each made and sent once the one before is
    // written (so the pieces are not all held as bytes at once), and never more than the web process
    // takes (`maxResultBytes`); exit after the last. The reply carries the peak memory of the whole
    // run, the answer included.
    const messages = answerMessages(reply, { maxResultBytes: req.maxResultBytes, peakRssKB: () => process.resourceUsage().maxRSS });
    const next = (err?: Error | null) => {
      if (err) process.exit(3);
      const step = messages.next();
      if (step.done) process.exit(0);
      send(step.value, undefined, undefined, next);
    };
    next();
  });
});
