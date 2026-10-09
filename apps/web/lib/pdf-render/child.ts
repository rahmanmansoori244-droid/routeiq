/**
 * Entry of the PDF renderer process (review M3). The web process forks it once per driver pack
 * (lib/pdf-render/index.ts) with a heap cap (--max-old-space-size) and no secrets in its
 * environment, sends it one RenderRequest, and kills it when it takes too long. It lays the pack out
 * (handler.ts), sends its RenderReply with its peak memory, and exits (protocol.ts). It is bundled
 * with esbuild into .next/pdf-renderer/render.cjs by `pnpm build` (scripts/build-pdf-renderer.mjs);
 * in development and tests scripts/pdf-renderer-dev.cjs builds and runs the same bundle.
 */
import { writeFileSync } from 'node:fs';
import { handleRenderRequest } from './handler';
import type { RenderRequest } from './protocol';

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
  console.error('pdf renderer: start it with an IPC channel (child_process.fork)');
  process.exit(2);
}
// The web process went away (or closed the channel): nothing will read the answer.
process.on('disconnect', () => process.exit(0));

process.once('message', (req: RenderRequest) => {
  void handleRenderRequest(req).then((reply) => {
    // The peak memory of the whole run, the answer included; exit once it is written.
    send({ ...reply, maxRssKB: process.resourceUsage().maxRSS }, undefined, undefined, (err) => process.exit(err ? 3 : 0));
  });
});
