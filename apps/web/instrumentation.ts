// Next.js 14 instrumentation hook — loaded once per runtime.
// Auto-imports the right Sentry config file for the current execution context.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
    const { configProblems } = await import('./lib/startup-checks');
    for (const p of configProblems()) {
      if (p.level === 'error') console.error(`[config] ${p.message}`);
      else console.warn(`[config] ${p.message}`);
    }
    // Audit P5: a production server reads a two-line CSV in an upload parser process once at
    // startup, so a missing or broken parser shows in the log at the deploy, not at the first upload.
    if (process.env.NODE_ENV === 'production') {
      const { checkUploadParser } = await import('./lib/upload-parse');
      void checkUploadParser().then((problem) => {
        if (problem) console.error(`[config] ${problem}`);
        else console.log('[upload-parse] the file reader works (startup check)');
      });
    }
    const { startJanitor } = await import('./lib/jobs/janitor-loop');
    startJanitor();
  } else if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}
