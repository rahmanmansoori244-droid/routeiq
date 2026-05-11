/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: '12mb' },
    instrumentationHook: true,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

// Wrap with Sentry config only when both the package and DSN are present.
// In dev without DSN, this is effectively a passthrough.
let exported = nextConfig;
try {
  const { withSentryConfig } = require('@sentry/nextjs');
  exported = withSentryConfig(nextConfig, {
    silent: !process.env.SENTRY_DSN,
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    // Don't upload source maps if DSN is unset (dev).
    disableServerWebpackPlugin: !process.env.SENTRY_DSN,
    disableClientWebpackPlugin: !process.env.SENTRY_DSN,
  });
} catch {
  // @sentry/nextjs not installed yet — keep raw config.
}

module.exports = exported;
