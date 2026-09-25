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
    const { startJanitor } = await import('./lib/jobs/janitor-loop');
    startJanitor();
  } else if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}
