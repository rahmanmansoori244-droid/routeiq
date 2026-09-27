/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Lint is gated separately in CI; do not block production builds on plugin
  // resolution quirks inside monorepo workspaces.
  eslint: { ignoreDuringBuilds: true },
  // The app uses no next/image. With `unoptimized` the image endpoint /_next/image answers 404
  // instead of fetching and resizing images for anyone who asks, without login (audit 27 Sep
  // 2026, F01: several Next.js 14 advisories without a 14.x fix are in that endpoint).
  images: { unoptimized: true },
  experimental: {
    // No `serverActions` settings: the app has no Server Actions, and a CI check keeps it that way
    // (scripts/check-build-output.ts, audit F01 / owner decision 4).
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
          // Baseline CSP (review F11 follow-up): no framing, no <base> hijack, no plugins, forms
          // post only to this origin. A full script-src policy needs nonces and waits for the
          // Next.js upgrade.
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
          },
        ],
      },
    ];
  },
};

// Sentry wraps the config when @sentry/nextjs is installed (it is a dependency). Error reporting
// itself is off until SENTRY_DSN is set (sentry.*.config.ts).
//
// Browser source maps are never served (audit 27 Sep 2026, side item). Sentry 8 turns on source
// map generation for every production build, and Next.js serves whatever lands in .next/static,
// so the maps of the browser code were public at /_next/static/chunks/*.js.map. Now:
//   - without an upload configured (SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT all set) no
//     source maps are made at all;
//   - with an upload, the browser maps are made, uploaded to Sentry and deleted from the build
//     before it is deployed (the deletion runs even when the upload fails). Sentry deletes only
//     the *.js.map files; the last step of `pnpm build` (scripts/remove-public-source-maps.mjs)
//     removes every .map left under .next/static, the CSS maps included.
// CI builds the app and fails if any .map file is left in .next/static (scripts/check-build-output.ts).
let exported = nextConfig;
try {
  const { withSentryConfig } = require('@sentry/nextjs');
  const uploadSourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT);
  exported = withSentryConfig(nextConfig, {
    silent: !process.env.SENTRY_DSN,
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    sourcemaps: {
      disable: !uploadSourceMaps,
      deleteSourcemapsAfterUpload: true,
    },
  });
} catch {
  // @sentry/nextjs not installed — keep raw config.
}

module.exports = exported;
